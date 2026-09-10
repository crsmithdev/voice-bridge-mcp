/**
 * Every default in the spec is a setting (spec 6.7). This file is the whole of
 * section 21: a builder does not write one of these values into the code.
 *
 * Read from $VOICE_BRIDGE_CONFIG, else ~/.voice-bridge/config.json. A missing
 * file is fine; a present one overrides field by field.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 8.4.3 no activity on any channel for this long and the process is dead */
  silenceMs: number;
  /** 8.5.2 more than this many compactions inside the window is a definite fault */
  compactionLimit: number;
  compactionWindowMs: number;
  /** 8.7.2 process memory, not context: a leak, not normal work */
  memoryRecycleBytes: number;
  /** 8.6.9 the ceiling ladder: ask, then interrupt, then restart */
  ceilingMs: number;
  checkpointWindowMs: number;
  graceMs: number;
  /** 8.11 final, and still a setting */
  model: string;
  /** 9.2 matched by sound, not spelling (9.3) */
  wakeWord: string;
  /** 9.5 the only two commands that work while muted; a list so it can grow (9.6) */
  mutedCommands: string[];
  /** 10.2 a specific word, never "yes" */
  agreementWord: string;
  /** 2.3 how long a tool call must run before the bridge says what it is */
  narrationDelayMs: number;
  /** 6.1 the bridge starts Claude Code in the project directory */
  claudeBin: string;
  claudeArgs: string[];
}

export const DEFAULTS: Config = {
  silenceMs: 60_000,
  compactionLimit: 3,
  compactionWindowMs: 300_000,
  memoryRecycleBytes: 4 * 1024 ** 3,
  ceilingMs: 600_000,
  checkpointWindowMs: 15_000,
  graceMs: 30_000,
  model: "sonnet",
  wakeWord: "hey bridge",
  mutedCommands: ["mute", "unmute"],
  agreementWord: "continue",
  narrationDelayMs: 5_000,
  claudeBin: "claude",
  // --verbose is not optional: claude refuses stream-json output without it
  claudeArgs: ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages"],
};

export function configPath(): string {
  return process.env.VOICE_BRIDGE_CONFIG ?? join(homedir(), ".voice-bridge", "config.json");
}

export function loadConfig(path = configPath()): Config {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { ...DEFAULTS }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must hold an object`);
  const merged: Config = { ...DEFAULTS, ...(parsed as Partial<Config>) };
  for (const key of ["silenceMs", "ceilingMs", "checkpointWindowMs", "graceMs", "compactionWindowMs", "narrationDelayMs"] as const) {
    if (typeof merged[key] !== "number" || !(merged[key] > 0)) throw new Error(`${key} must be a positive number of milliseconds`);
  }
  // 10.3 a reflex or a bad transcription must not be able to say the agreement word
  if (!merged.agreementWord || merged.agreementWord.toLowerCase() === "yes") {
    throw new Error('agreementWord must be a specific word, and must not be "yes"');
  }
  return merged;
}
