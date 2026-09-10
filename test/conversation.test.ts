import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";

const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60_000 };
const silent = { say: async () => {}, cue: () => {}, tell: () => {} };
const engines = { start: async () => {}, transcribe: async () => "", synthesize: async () => "", stop: () => {} };

function withTranscript(entries: Array<Record<string, unknown>>): Conversation {
  const c = new Conversation("/tmp", config, silent, engines as never, engines as never);
  (c as unknown as { transcript: Array<Record<string, unknown>> }).transcript.push(...entries);
  return c;
}

describe("what a client missed (14.8)", () => {
  test("a drop in a tunnel is minutes, so recent turns come back", () => {
    const now = 1_000_000;
    const c = withTranscript([{ kind: "turn", text: "recent", at: now - 30_000 }]);
    expect(c.missed(now).map((e) => e.text)).toEqual(["recent"]);
  });
  test("an exchange from hours ago is not something this client missed", () => {
    const now = 1_000_000;
    const c = withTranscript([
      { kind: "turn", text: "hours ago", at: now - 7_200_000 },
      { kind: "turn", text: "just now", at: now - 5_000 },
    ]);
    // replaying the old one arrives looking like the conversation in progress
    expect(c.missed(now).map((e) => e.text)).toEqual(["just now"]);
  });
});
