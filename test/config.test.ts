import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "vb-config-"));
function withFile(body: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, body);
  return path;
}

describe("config (21)", () => {
  test("no file means the spec defaults", () => {
    expect(loadConfig(join(dir, "missing.json"))).toEqual(DEFAULTS);
  });
  test("the defaults are the values the spec settles on", () => {
    expect(DEFAULTS.silenceMs).toBe(60_000);
    expect(DEFAULTS.ceilingMs).toBe(600_000);
    expect(DEFAULTS.checkpointWindowMs).toBe(15_000);
    expect(DEFAULTS.graceMs).toBe(30_000);
    expect(DEFAULTS.model).toBe("sonnet");
    expect(DEFAULTS.wakeWord).toBe("hey bridge");
    expect(DEFAULTS.agreementWord).toBe("continue");
    expect(DEFAULTS.mutedCommands).toEqual(["mute", "unmute"]);
  });
  test("a file overrides field by field", () => {
    const config = loadConfig(withFile('{"model":"opus","ceilingMs":60000}'));
    expect(config.model).toBe("opus");
    expect(config.ceilingMs).toBe(60_000);
    expect(config.silenceMs).toBe(DEFAULTS.silenceMs);
  });
  test('the agreement word can never be "yes" (10.2)', () => {
    expect(() => loadConfig(withFile('{"agreementWord":"yes"}'))).toThrow(/must not be "yes"/);
    expect(() => loadConfig(withFile('{"agreementWord":"Yes"}'))).toThrow(/must not be "yes"/);
    expect(loadConfig(withFile('{"agreementWord":"proceed"}')).agreementWord).toBe("proceed");
  });
  test("a timer that is not a positive number is refused, not silently defaulted", () => {
    expect(() => loadConfig(withFile('{"silenceMs":0}'))).toThrow(/positive number/);
    expect(() => loadConfig(withFile('{"ceilingMs":"ten"}'))).toThrow(/positive number/);
  });
  test("a broken file is an error, not a silent fallback", () => {
    expect(() => loadConfig(withFile("{oops"))).toThrow(/not valid JSON/);
    expect(() => loadConfig(withFile("[]"))).toThrow(/must hold an object/);
  });
});
