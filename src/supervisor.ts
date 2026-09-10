/**
 * The three fault detectors of spec section 8. Pure state plus a clock, so the
 * whole ladder is testable without a process: feed it events and call
 * evaluate(now).
 *
 * Silence (8.4) finds a process that stopped. The compaction loop (8.5) finds
 * one that is busy but stuck. The ceiling (8.6) finds one that is active and
 * wrong, and escalates rather than killing a session that may be healthy.
 */
import type { Config } from "./config.ts";

export type Action =
  | { kind: "none" }
  /** 8.6.3 speak, say how long it has run, ask for the agreement word */
  | { kind: "checkpoint"; runningMs: number }
  /** 8.6.5 stop the turn, keep the process */
  | { kind: "interrupt"; reason: string }
  /** 8.4.3, 8.5.2, 8.6.7, 8.7.2 */
  | { kind: "restart"; reason: string };

export class Supervisor {
  private turnStartedAt: number | null = null;
  private lastActivityAt = 0;
  private ceilingAt = 0;
  private checkpointAt: number | null = null;
  private interruptAt: number | null = null;
  private compactions: number[] = [];
  private toolsInFlight = new Set<string>();
  private memoryBytes = 0;
  private fired = false;

  constructor(private readonly config: Config) {}

  turnStarted(now: number): void {
    this.turnStartedAt = now;
    this.lastActivityAt = now;
    this.ceilingAt = now + this.config.ceilingMs;
    this.checkpointAt = null;
    this.interruptAt = null;
    this.toolsInFlight.clear();
    this.fired = false;
  }

  /** 8.6.10 the ceiling measures one turn; a new turn starts the timer again. */
  turnEnded(now: number): void {
    this.turnStartedAt = null;
    this.lastActivityAt = now;
    this.toolsInFlight.clear();
    this.checkpointAt = null;
    this.interruptAt = null;
  }

  activity(now: number): void {
    this.lastActivityAt = now;
  }

  /**
   * A tool call that runs for minutes emits nothing on any channel while it
   * runs, so it looks exactly like a dead process. Holding the silence timer
   * for the length of the call is what lets a project run a slow command.
   */
  toolStarted(id: string, now: number): void {
    this.toolsInFlight.add(id);
    this.lastActivityAt = now;
  }

  toolEnded(id: string, now: number): void {
    this.toolsInFlight.delete(id);
    this.lastActivityAt = now;
  }

  compacted(now: number): void {
    this.lastActivityAt = now;
    this.compactions.push(now);
  }

  /** 8.6.4 the agreement word buys one more ceiling, and can repeat. */
  agreed(now: number): void {
    this.checkpointAt = null;
    this.ceilingAt = now + this.config.ceilingMs;
    this.fired = false;
  }

  interruptSent(now: number): void {
    this.interruptAt = now;
  }

  memorySample(bytes: number): void {
    this.memoryBytes = bytes;
  }

  private compactionsSince(now: number): number {
    const cutoff = now - this.config.compactionWindowMs;
    this.compactions = this.compactions.filter((at) => at >= cutoff);
    return this.compactions.length;
  }

  evaluate(now: number): Action {
    const { config } = this;

    // 8.5.3 act at once: the process is busy, so the silence timer would never start
    if (this.compactionsSince(now) > config.compactionLimit) {
      this.compactions = [];
      return { kind: "restart", reason: "compaction loop" };
    }

    // 8.7 a planned recycle, taken between turns so it never lands mid-answer
    if (this.turnStartedAt === null) {
      if (this.memoryBytes > config.memoryRecycleBytes) {
        this.memoryBytes = 0;
        return { kind: "restart", reason: "process memory over the recycle limit" };
      }
      return { kind: "none" };
    }

    // 8.6.7 a process that will not take an interrupt is wedged, and that is the evidence for a restart
    if (this.interruptAt !== null) {
      if (now - this.interruptAt >= config.graceMs) return { kind: "restart", reason: "the interrupt did not work" };
      return { kind: "none" };
    }

    // 8.4 before the ceiling: a process that stopped is dead, and asking a dead
    // process to say the agreement word only wastes the checkpoint and the grace.
    // Only while a turn is running, and never while a tool call is in flight.
    if (this.toolsInFlight.size === 0 && now - this.lastActivityAt >= config.silenceMs) {
      return { kind: "restart", reason: "no activity on any channel" };
    }

    // 8.6.5 fails closed (8.6.6): no agreement word, no more turn
    if (this.checkpointAt !== null) {
      if (now - this.checkpointAt >= config.checkpointWindowMs) return { kind: "interrupt", reason: "no agreement at the ceiling" };
      return { kind: "none" };
    }

    // 8.6.3 one checkpoint per ceiling; agreed() arms the next
    if (now >= this.ceilingAt && !this.fired) {
      this.fired = true;
      this.checkpointAt = now;
      return { kind: "checkpoint", runningMs: now - this.turnStartedAt };
    }

    return { kind: "none" };
  }
}
