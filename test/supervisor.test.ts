import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Supervisor } from "../src/supervisor.ts";

const config: Config = { ...DEFAULTS, silenceMs: 1_000, ceilingMs: 10_000, checkpointWindowMs: 500, graceMs: 800, compactionLimit: 3, compactionWindowMs: 5_000 };

function running(now = 0, overrides: Partial<Config> = {}): Supervisor {
  const supervisor = new Supervisor({ ...config, ...overrides });
  supervisor.turnStarted(now);
  return supervisor;
}

/** for tests about one detector, put the ceiling far out of the way */
const NO_CEILING = { ceilingMs: 3_600_000 };

describe("silence detector (8.4)", () => {
  test("restarts after the silence time with no activity", () => {
    const s = running(0);
    expect(s.evaluate(999)).toEqual({ kind: "none" });
    expect(s.evaluate(1_000)).toEqual({ kind: "restart", reason: "no activity on any channel" });
  });
  test("activity of any kind resets the timer", () => {
    const s = running(0);
    s.activity(900);
    expect(s.evaluate(1_500)).toEqual({ kind: "none" });
    expect(s.evaluate(1_900)).toEqual({ kind: "restart", reason: "no activity on any channel" });
  });
  test("a tool call in flight holds the timer for as long as it runs", () => {
    const s = running(0, NO_CEILING);
    s.toolStarted("t1", 10);
    // a command that takes minutes emits nothing at all while it runs
    expect(s.evaluate(300_000)).toEqual({ kind: "none" });
    s.toolEnded("t1", 300_000);
    expect(s.evaluate(300_500)).toEqual({ kind: "none" });
    expect(s.evaluate(301_000)).toEqual({ kind: "restart", reason: "no activity on any channel" });
  });
  test("an idle process between turns is not a fault", () => {
    const s = running(0);
    s.turnEnded(10);
    expect(s.evaluate(500_000)).toEqual({ kind: "none" });
  });
});

describe("compaction loop (8.5)", () => {
  test("fires past the limit inside the window, without waiting for silence", () => {
    const s = running(0);
    for (const at of [100, 200, 300]) s.compacted(at);
    expect(s.evaluate(300)).toEqual({ kind: "none" });
    s.compacted(400);
    expect(s.evaluate(400)).toEqual({ kind: "restart", reason: "compaction loop" });
  });
  test("a compaction now and then is healthy", () => {
    const s = running(0, NO_CEILING);
    for (const at of [0, 6_000, 12_000, 18_000]) { s.compacted(at); expect(s.evaluate(at)).toEqual({ kind: "none" }); }
  });
});

describe("the ceiling ladder (8.6)", () => {
  test("asks first, and the agreement word buys another ceiling", () => {
    const s = running(0);
    s.activity(9_900); // still producing output: alive, and past the ceiling
    expect(s.evaluate(10_000)).toEqual({ kind: "checkpoint", runningMs: 10_000 });
    expect(s.evaluate(10_100)).toEqual({ kind: "none" });
    s.agreed(10_200);
    s.activity(19_900);
    expect(s.evaluate(20_000)).toEqual({ kind: "none" });
    s.activity(20_100);
    expect(s.evaluate(20_200)).toEqual({ kind: "checkpoint", runningMs: 20_200 });
  });
  test("fails closed: no agreement word, so the turn is interrupted", () => {
    const s = running(0);
    s.activity(10_000);
    expect(s.evaluate(10_000)).toEqual({ kind: "checkpoint", runningMs: 10_000 });
    s.activity(10_400);
    expect(s.evaluate(10_499)).toEqual({ kind: "none" });
    expect(s.evaluate(10_500)).toEqual({ kind: "interrupt", reason: "no agreement at the ceiling" });
  });
  test("restarts only once the interrupt is shown not to work", () => {
    const s = running(0);
    s.activity(10_000);
    s.evaluate(10_000);
    s.activity(10_400);
    s.evaluate(10_500);
    s.interruptSent(10_500);
    expect(s.evaluate(11_200)).toEqual({ kind: "none" });
    expect(s.evaluate(11_300)).toEqual({ kind: "restart", reason: "the interrupt did not work" });
  });
  test("an interrupt that works ends the turn and restarts nothing", () => {
    const s = running(0);
    s.activity(10_000);
    s.evaluate(10_000);
    s.activity(10_400);
    s.evaluate(10_500);
    s.interruptSent(10_500);
    s.turnEnded(10_600);
    expect(s.evaluate(60_000)).toEqual({ kind: "none" });
  });
  test("a busy turn under the ceiling is left alone", () => {
    const s = running(0);
    for (let at = 0; at < 9_000; at += 500) s.activity(at);
    expect(s.evaluate(9_000)).toEqual({ kind: "none" });
  });
});

describe("process memory recycle (8.7)", () => {
  test("recycles between turns, never mid-answer", () => {
    const s = running(0);
    s.memorySample(config.memoryRecycleBytes + 1);
    s.activity(100);
    expect(s.evaluate(200)).toEqual({ kind: "none" });
    s.turnEnded(300);
    expect(s.evaluate(400)).toEqual({ kind: "restart", reason: "process memory over the recycle limit" });
  });
  test("a normal footprint is left alone", () => {
    const s = new Supervisor(config);
    s.memorySample(config.memoryRecycleBytes - 1);
    expect(s.evaluate(1_000)).toEqual({ kind: "none" });
  });
});

describe("which detector wins", () => {
  test("a dead process restarts rather than being asked to say the agreement word", () => {
    // past the ceiling and silent at the same time: silence means dead, and a
    // dead process cannot answer a checkpoint, so waiting out the window and
    // then the grace would only delay the restart by both
    const s = running(0);
    expect(s.evaluate(11_000)).toEqual({ kind: "restart", reason: "no activity on any channel" });
  });
  test("a compaction loop beats the silence timer it would never trip", () => {
    const s = running(0);
    for (const at of [100, 200, 300, 400]) s.compacted(at);
    expect(s.evaluate(2_000)).toEqual({ kind: "restart", reason: "compaction loop" });
  });
});
