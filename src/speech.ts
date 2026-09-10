/**
 * The voice engines (spec 4.5-4.9).
 *
 * 4.5 is a constraint, not a default: no part of this path reaches a cloud
 * service, in any mode, at any time. 4.8 says each engine sits behind an
 * interface and that the interface accepts local engines only, so there is no
 * cloud implementation to select and no fallback when a local one fails.
 *
 * Each engine is a long-lived Python worker under speech/. Both cost seconds
 * to load and a fraction of a second to run, so the bridge starts them once
 * and warms them before Chris says anything.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { LineSplitter } from "./protocol.ts";

/** 4.8 the seam. A local engine only: there is no cloud engine to put here. */
export interface SpeechToText {
  start(): Promise<void>;
  transcribe(wavPath: string): Promise<string>;
  stop(): void;
}

export interface TextToSpeech {
  start(): Promise<void>;
  /** Writes the speech to wavPath and returns it. */
  synthesize(text: string, wavPath: string): Promise<string>;
  stop(): void;
}

/**
 * The CUDA libraries that ship as wheels inside the virtual environment.
 * ctranslate2 wants CUDA 12 and finds nothing on the system path, because the
 * only CUDA on this machine belongs to torch and is CUDA 13.
 */
function cudaLibraryPath(pythonBin: string): string {
  const root = join(dirname(dirname(pythonBin)), "lib");
  const dirs: string[] = [];
  try {
    for (const python of readdirSync(root)) {
      const nvidia = join(root, python, "site-packages", "nvidia");
      if (!existsSync(nvidia)) continue;
      for (const pkg of readdirSync(nvidia)) {
        const lib = join(nvidia, pkg, "lib");
        if (existsSync(lib)) dirs.push(lib);
      }
    }
  } catch { /* no wheels: the worker says so itself */ }
  return dirs.join(":");
}

/** One Python worker: a JSON request a line in, a JSON reply a line out. */
class Worker {
  private child: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private waiting: Array<(reply: Record<string, unknown>) => void> = [];

  constructor(private readonly bin: string, private readonly args: string[], private readonly env: Record<string, string>) {}

  async start(): Promise<Record<string, unknown>> {
    const ready = this.next();
    this.child = Bun.spawn([this.bin, ...this.args], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: { ...process.env, ...this.env },
    }) as Subprocess<"pipe", "pipe", "inherit">;
    void this.pump();
    const first = await ready;
    if (first.ready !== true) throw new Error(`${this.args[0]} did not start: ${JSON.stringify(first)}`);
    return first;
  }

  private async pump(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const splitter = new LineSplitter();
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      for (const line of splitter.push(decoder.decode(chunk, { stream: true }))) {
        const resolve = this.waiting.shift();
        if (!resolve) continue;
        try { resolve(JSON.parse(line) as Record<string, unknown>); }
        catch { resolve({ error: `the worker said something that is not JSON: ${line.slice(0, 120)}` }); }
      }
    }
    while (this.waiting.length) this.waiting.shift()?.({ error: "the worker stopped" });
  }

  private next(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async request(value: unknown): Promise<Record<string, unknown>> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("the worker is not running");
    const reply = this.next();
    stdin.write(`${JSON.stringify(value)}\n`);
    stdin.flush();
    const result = await reply;
    if (typeof result.error === "string") throw new Error(result.error);
    return result;
  }

  stop(): void {
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = null;
  }
}

/** 4.6 a small Whisper-family model, on the GPU, faster than real time. */
export class LocalWhisper implements SpeechToText {
  private worker: Worker;
  /** what the warmup cost, so 18.4 has a number to report */
  warmupSeconds = 0;

  constructor(config: Config, scriptDir: string) {
    this.worker = new Worker(config.pythonBin, [join(scriptDir, "stt_worker.py"), config.sttModel, config.modelsDir],
      { LD_LIBRARY_PATH: cudaLibraryPath(config.pythonBin) });
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.warmupSeconds = typeof ready.warmup_seconds === "number" ? ready.warmup_seconds : 0;
  }

  async transcribe(wavPath: string): Promise<string> {
    const reply = await this.worker.request({ wav: wavPath });
    return typeof reply.text === "string" ? reply.text : "";
  }

  stop(): void { this.worker.stop(); }
}

/** 4.9 the first working local voice. The voice is a setting; every choice is local. */
export class LocalPiper implements TextToSpeech {
  private worker: Worker;
  sampleRate = 0;

  constructor(config: Config, scriptDir: string) {
    this.worker = new Worker(config.pythonBin, [join(scriptDir, "tts_worker.py"), join(config.modelsDir, `${config.ttsVoice}.onnx`)], {});
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.sampleRate = typeof ready.sample_rate === "number" ? ready.sample_rate : 0;
  }

  async synthesize(text: string, wavPath: string): Promise<string> {
    const reply = await this.worker.request({ text, wav: wavPath });
    return typeof reply.wav === "string" ? reply.wav : wavPath;
  }

  stop(): void { this.worker.stop(); }
}
