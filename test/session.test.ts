import { describe, expect, test } from "bun:test";
import { processRssBytes } from "../src/session.ts";

// 8.7 the recycle guard was dead code until something sampled the process size
describe("process memory (8.7)", () => {
  test("reads the resident size of a live process", () => {
    const bytes = processRssBytes(process.pid);
    expect(bytes).toBeGreaterThan(1024 * 1024);
  });
  test("a process that is gone reports nothing rather than zero", () => {
    expect(processRssBytes(2 ** 30)).toBeNull();
  });
});
