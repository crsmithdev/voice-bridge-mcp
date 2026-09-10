/**
 * The wake-word commands of spec section 9.
 *
 * 9.3 is the whole difficulty: the bridge matches the sound of the wake word,
 * not its spelling. A speech-to-text engine writes "hey bridge" as "hey,
 * bridge", "Hey Bridge!", "hebridge" or "a bridge" depending on how it heard
 * it. So the match strips everything but the letters, closes up the spaces and
 * allows a couple of characters of difference.
 *
 * The same tolerance applies to the command that follows: a command is a set
 * of words to find, not a phrase to match exactly.
 */
export type CommandName =
  | "mute" | "unmute" | "clearContext" | "usage"
  | "restate" | "summarize" | "where" | "endTurn";

export type Match =
  /** 9.4 a command to do */
  | { kind: "command"; name: CommandName }
  /** 9.7 the wake word came through but the command did not */
  | { kind: "unclear" }
  /** no wake word: this is a thing Chris said to the agent */
  | { kind: "speech" };

/** Every word that names a command, and the words that have to be there. */
const COMMANDS: Array<{ name: CommandName; any: string[][] }> = [
  { name: "unmute", any: [["unmute"], ["un", "mute"], ["listen", "again"]] },
  { name: "mute", any: [["mute"], ["stop", "listening"]] },
  { name: "clearContext", any: [["clear"]] },
  { name: "usage", any: [["usage"], ["cost"], ["spent"]] },
  { name: "restate", any: [["restate"], ["say", "again"], ["repeat"]] },
  { name: "summarize", any: [["summarize"], ["summarise"], ["summary"]] },
  { name: "where", any: [["where"], ["catch", "up"], ["recap"]] },
  { name: "endTurn", any: [["end", "turn"], ["stop"], ["cancel"], ["never", "mind"]] },
];

/** Letters and spaces only, collapsed: what the sound was, not how it was written. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** How much of a spelling difference to forgive: longer words earn more. */
function tolerance(word: string): number {
  return word.length <= 5 ? 1 : Math.min(3, Math.floor(word.length / 4));
}

/**
 * The wake word gets one character of tolerance, not the usual share. "the
 * bridge" is two characters from "hey bridge" in spelling and nothing like it
 * in sound, and "The bridge is ready" is a sentence Chris says out loud.
 */
const WAKE_TOLERANCE = 1;

/** 9.1 a voice command starts with the wake word; only a false start may precede it. */
const WAKE_WINDOW = 2;

/**
 * The text after the wake word, or null when the wake word is not there.
 * The wake word may be anywhere: an engine often puts a false start in front.
 */
export function afterWakeWord(said: string, wakeWord: string, variants: string[] = []): string | null {
  const words = normalize(said).split(" ").filter(Boolean);
  const targets = [wakeWord, ...variants].map((form) => normalize(form).replace(/ /g, "")).filter(Boolean);
  if (targets.length === 0) return null;
  const span = Math.max(...[wakeWord, ...variants].map((form) => normalize(form).split(" ").length));
  // try the wake word as one word, then as the number of words it is written with
  for (let i = 0; i < Math.min(words.length, WAKE_WINDOW); i++) {
    for (let take = 1; take <= span && i + take <= words.length; take++) {
      const candidate = words.slice(i, i + take).join("");
      if (targets.some((target) => editDistance(candidate, target) <= WAKE_TOLERANCE)) return words.slice(i + take).join(" ");
    }
  }
  return null;
}

/** 9.4 which command the words after the wake word name, if any. */
export function commandIn(rest: string): CommandName | null {
  const words = rest.split(" ").filter(Boolean);
  const near = (want: string) => words.some((word) => editDistance(word, want) <= tolerance(want));
  for (const { name, any } of COMMANDS) {
    if (any.some((all) => all.every(near))) return name;
  }
  return null;
}

/**
 * 9.5 two commands work while muted, and 9.6 makes that set a setting, so the
 * gate is a list lookup rather than a pair of names in the code.
 */
export function match(said: string, wakeWord: string, muted: boolean, mutedCommands: string[], variants: string[] = []): Match {
  const rest = afterWakeWord(said, wakeWord, variants);
  if (rest === null) return { kind: "speech" };
  const name = commandIn(rest);
  if (name === null) return { kind: "unclear" };
  if (muted && !mutedCommands.includes(name)) return { kind: "unclear" };
  return { kind: "command", name };
}
