import { describe, expect, test } from "bun:test";
import { SentenceCollector } from "../src/sentences.ts";

describe("sentence collector (5.6)", () => {
  test("a sentence is ready as soon as its end is certain", () => {
    const c = new SentenceCollector(240);
    expect(c.push("The bridge is ready")).toEqual([]);
    // the full stop alone is not enough: the next character may make it a number
    expect(c.push(".")).toEqual([]);
    expect(c.push(" And")).toEqual(["The bridge is ready."]);
  });
  test("a decimal is not the end of a sentence", () => {
    const c = new SentenceCollector(240);
    expect(c.push("it costs 3.5 cents. ")).toEqual(["it costs 3.5 cents."]);
  });
  test("a newline ends a sentence, for a list", () => {
    const c = new SentenceCollector(240);
    expect(c.push("one\ntwo\n")).toEqual(["one", "two"]);
  });
  test("a closing quote stays with its sentence", () => {
    const c = new SentenceCollector(240);
    expect(c.push('he said "go." then left. ')).toEqual(['he said "go."', "then left."]);
  });
  test("a long run with no punctuation is broken at a space, so the audio is not held back", () => {
    const c = new SentenceCollector(20);
    expect(c.push("aaaa bbbb cccc dddd eeee ffff")).toEqual(["aaaa bbbb cccc dddd"]);
  });
  test("the tail of a reply is a sentence even without punctuation", () => {
    const c = new SentenceCollector(240);
    c.push("no full stop here");
    expect(c.flush()).toBe("no full stop here");
    expect(c.flush()).toBeNull();
  });
});
