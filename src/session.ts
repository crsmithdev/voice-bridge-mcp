/**
 * One long-lived Claude Code process, text in and text out (spec 7.2).
 *
 * The process stays alive for the whole conversation (3.3) and never sees
 * audio. The supervisor drives it: this file only owns the pipes, the turn
 * numbers (14.5) and the restart.
 */
import { readFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { Narrator } from "./narrator.ts";
import { LineSplitter, contextTokens, parseLine, type Event, type Usage } from "./protocol.ts";
import { Supervisor, type Action } from "./supervisor.ts";

export interface Turn {
  /** 14.5 a number per turn, so a recovery command is not ambiguous */
  number: number;
  text: string;
  costUsd: number;
  isError: boolean;
}

/** 8.7.1 the resident size of the process, in bytes; null when it is gone. */
export function processRssBytes(pid: number): number | null {
  let status: string;
  try { status = readFileSync(`/proc/${pid}/status`, "utf8"); } catch { return null; }
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

export interface SessionHooks {
  /** 8.6.3 the bridge speaks at the checkpoint and waits for the agreement word */
  onCheckpoint?(runningMs: number): void;
  /** 5.5 the reply word by word; 7.3 collects it to a sentence and speaks it */
  onDelta?(text: string): void;
  /** 2.3 what the bridge says while a tool runs, so a long turn is not silence */
  onNarration?(text: string): void;
  onRestart?(reason: string): void;
  onInterrupt?(reason: string): void;
  /** 15.2 something to play while a turn is long */
  onEvent?(event: Event): void;
}

const TICK_MS = 1_000;

export class Session {
  private child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private supervisor: Supervisor;
  private narrator: Narrator;
  private turnNumber = 0;
  private pending: { resolve(turn: Turn): void; reject(error: Error): void } | null = null;
  private replyText = "";
  private costUsd = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 8.9 the window and the compaction threshold, once claude reports them */
  contextWindow = 0;
  contextThreshold = 0;
  contextUsed = 0;
  rateLimit: { fiveHour: number; sevenDay: number } = { fiveHour: 0, sevenDay: 0 };

  constructor(private readonly dir: string, private readonly config: Config, private readonly hooks: SessionHooks = {}) {
    this.supervisor = new Supervisor(config);
    this.narrator = new Narrator(config);
  }

  start(): void {
    if (this.child) return;
    this.child = Bun.spawn([this.config.claudeBin, ...this.config.claudeArgs, "--model", this.config.model], {
      cwd: this.dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as Subprocess<"pipe", "pipe", "pipe">;
    void this.pump(this.child);
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS);
  }

  /**
   * A restart leaves this loop draining the stream of the process it killed.
   * That loop must not speak for the process that replaced it, so every step
   * checks that the child it reads is still the current one: without the check
   * the dying process rejects the first turn of its successor.
   */
  private async pump(child: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const splitter = new LineSplitter();
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      if (this.child !== child) return;
      for (const line of splitter.push(decoder.decode(chunk, { stream: true }))) {
        for (const event of parseLine(line)) this.handle(event, Date.now());
      }
    }
    if (this.child !== child) return;
    // the stream ended: either we killed it, or it died and the silence timer is about to say so
    if (this.pending) this.fail(new Error("the Claude Code process ended mid-turn"));
  }

  private handle(event: Event, now: number): void {
    this.supervisor.activity(now);
    this.hooks.onEvent?.(event);
    switch (event.kind) {
      case "toolStart": this.supervisor.toolStarted(event.id, now); this.narrator.started(event.id, event.tool, event.parentId, now); break;
      case "toolEnd": this.supervisor.toolEnded(event.id, now); this.narrator.ended(event.id); break;
      case "compaction": this.supervisor.compacted(now); break;
      case "text": this.replyText += event.text; break;
      case "delta": this.hooks.onDelta?.(event.text); break;
      // 8.6.5 the receipt says the process took the interrupt. It does not say the
      // process is ready, so 8.6.7 still measures readiness by the grace time.
      case "controlResponse": this.hooks.onInterrupt?.(event.ok ? "the process took the interrupt" : "the process refused the interrupt"); break;
      case "context": this.contextWindow = event.window; this.contextThreshold = event.threshold; break;
      case "rateLimit": this.rateLimit = { fiveHour: event.fiveHour, sevenDay: event.sevenDay }; break;
      case "result": this.finish(event.text, event.costUsd, event.usage, event.isError, now); break;
      default: break;
    }
  }

  private finish(text: string, costUsd: number, usage: Usage, isError: boolean, now: number): void {
    this.costUsd += costUsd;
    this.contextUsed = contextTokens(usage);
    this.supervisor.turnEnded(now);
    this.narrator.turnEnded();
    const turn: Turn = { number: this.turnNumber, text: text || this.replyText.trim(), costUsd, isError };
    this.replyText = "";
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(turn);
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  /** 8.6 the ladder, once a second. 8.7 samples the process memory on the same tick. */
  private tick(now: number): void {
    const pid = this.child?.pid;
    if (pid !== undefined) {
      const rss = processRssBytes(pid);
      if (rss !== null) this.supervisor.memorySample(rss);
    }
    for (const phrase of this.narrator.due(now)) this.hooks.onNarration?.(phrase);
    const action: Action = this.supervisor.evaluate(now);
    switch (action.kind) {
      case "checkpoint":
        this.hooks.onCheckpoint?.(action.runningMs);
        break;
      case "interrupt":
        this.hooks.onInterrupt?.(action.reason);
        this.interrupt(now);
        break;
      case "restart":
        this.hooks.onRestart?.(action.reason);
        this.restart(action.reason);
        break;
      default:
        break;
    }
  }

  /** 8.6.4 the agreement word buys another ceiling. */
  agree(now = Date.now()): void {
    this.supervisor.agreed(now);
  }

  /**
   * 8.6.5 stop the turn, keep the process. Claude Code takes an interrupt on
   * its input stream; if it does not, 8.6.7 restarts after the grace time.
   */
  interrupt(now = Date.now()): void {
    this.supervisor.interruptSent(now);
    this.write({ type: "control_request", request: { subtype: "interrupt" } });
  }

  restart(reason: string): void {
    this.stop();
    this.fail(new Error(`restarted: ${reason}`));
    this.start();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = null;
  }

  private write(value: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin) return;
    try { stdin.write(`${JSON.stringify(value)}\n`); stdin.flush(); } catch { /* the restart will notice */ }
  }

  /** One turn: text in, text out. Claude Code never sees audio (3.3). */
  ask(text: string): Promise<Turn> {
    if (!this.child) this.start();
    if (this.pending) return Promise.reject(new Error("a turn is already running"));
    this.turnNumber += 1;
    this.replyText = "";
    this.supervisor.turnStarted(Date.now());
    this.write({ type: "user", message: { role: "user", content: text } });
    return new Promise<Turn>((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  /** 8.9 how close the context is to a compaction, now that claude reports both numbers. */
  contextFraction(): number | null {
    if (!this.contextThreshold) return null;
    return this.contextUsed / this.contextThreshold;
  }

  totalCostUsd(): number {
    return this.costUsd;
  }
}
