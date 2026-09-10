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
  /** 9.3 the other things the engine writes when it hears the wake word (18.8) */
  wakeWordVariants: string[];
  /** 9.5 the only two commands that work while muted; a list so it can grow (9.6) */
  mutedCommands: string[];
  /** 10.2 a specific word, never "yes" */
  agreementWord: string;
  /** 2.3 how long a tool call must run before the bridge says what it is */
  narrationDelayMs: number;
  /** 4.5 the whole voice path is local; these name local engines only (4.8) */
  pythonBin: string;
  modelsDir: string;
  /** 4.6 a small Whisper-family model */
  sttModel: string;
  /** 4.9 the first working local voice, and a setting from then on */
  ttsVoice: string;
  /** 5.6 a run of text this long with no punctuation is spoken anyway */
  sentenceMaxChars: number;
  /** 11.5 the pause that ends a turn, and the level that counts as speech */
  endOfTurnPauseMs: number;
  silenceThreshold: string;
  /** the same level as a fraction, for the transports that count samples themselves */
  speechLevel: number;
  /** how long the level must stay up before the bridge treats it as speech */
  speechOnsetMs: number;
  /** how long to let the speakers drain before listening again, so the bridge does not hear itself */
  listenSettleMs: number;
  /** 6.5 the voice instruction lives in the bridge, not in the aleph identity file */
  voiceInstruction: string;
  /** 15.5 how long a wait has to be before a cue is worth playing */
  audioCueDelayMs: number;
  /** 15.2 how often the cue repeats while the wait goes on */
  audioCueEveryMs: number;
  /** 13.2 the reported rate-limit use that earns a spoken warning */
  usageWarnFraction: number;
  /** 4.1 the transport. Empty keys mean the pair in ~/.voice-bridge/keys.json. */
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitPort: number;
  /** the address the phone uses. Empty means the tailnet address, else this machine's. */
  advertiseHost: string;
  /**
   * 12.1 A browser gives no microphone to a page that is not a secure context,
   * and only loopback is exempt. A phone therefore needs https, and an https
   * page may only open a wss socket. Either terminate TLS in front of the
   * bridge and set these two, or give the bridge a certificate below.
   */
  publicOrigin: string;
  livekitPublicUrl: string;
  tlsCert: string;
  tlsKey: string;
  /** 12.1 the port the bridge serves the client and the pairing on */
  servePort: number;
  /** the room the bridge and the phone meet in */
  room: string;
  /** 12.2 how long the token the client keeps stays good */
  tokenDays: number;
  /** 14.8 how far back "the turns it missed" reaches. A drop in a tunnel is minutes. */
  historyMaxAgeMs: number;
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
  // small.en writes "hey bridge" as "Cambridge" about half the time. 9.3 says
  // the bridge accepts the forms the engine produces; 18.8 says find them by use.
  wakeWordVariants: ["cambridge"],
  mutedCommands: ["mute", "unmute"],
  agreementWord: "continue",
  narrationDelayMs: 5_000,
  pythonBin: new URL("../.venv/bin/python", import.meta.url).pathname,
  modelsDir: join(homedir(), ".voice-bridge", "models"),
  sttModel: "small.en",
  ttsVoice: "en_US-lessac-medium",
  sentenceMaxChars: 240,
  endOfTurnPauseMs: 1_500,
  silenceThreshold: "2%",
  speechLevel: 0.02,
  speechOnsetMs: 50,
  listenSettleMs: 300,
  // 6.6 a spoken conversation: summarize, and never read a path, a diff, code or a secret aloud
  voiceInstruction: [
    "You are in a spoken conversation. A text to speech engine reads your reply aloud.",
    "Do not read file paths, diffs, code or secrets aloud. Summarize them instead.",
    "Answer in short plain sentences. Do not use markdown, lists, headers or code blocks.",
  ].join(" "),
  audioCueDelayMs: 4_000,
  audioCueEveryMs: 6_000,
  usageWarnFraction: 0.8,
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitPort: 7880,
  advertiseHost: "",
  publicOrigin: "",
  livekitPublicUrl: "",
  tlsCert: "",
  tlsKey: "",
  servePort: 3100,
  room: "bridge",
  tokenDays: 30,
  historyMaxAgeMs: 900_000,
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
