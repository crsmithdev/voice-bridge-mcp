import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Narrator, phraseFor } from "../src/narrator.ts";

const config: Config = { ...DEFAULTS, narrationDelayMs: 1_000 };

describe("narrator (2.3)", () => {
  test("a quick call says nothing", () => {
    const n = new Narrator(config);
    n.started("t1", "Read", null, 0);
    n.ended("t1");
    expect(n.due(5_000)).toEqual([]);
  });
  test("a call that outlives the delay is said once", () => {
    const n = new Narrator(config);
    n.started("t1", "Bash", null, 0);
    expect(n.due(999)).toEqual([]);
    expect(n.due(1_000)).toEqual(["running a command"]);
    // one phrase per call, however long it then runs
    expect(n.due(60_000)).toEqual([]);
  });
  test("a call inside a subagent says so", () => {
    const n = new Narrator(config);
    n.started("a1", "Agent", null, 0);
    n.started("t1", "Bash", "a1", 0);
    expect(n.due(1_000).sort()).toEqual(["starting a subagent", "the subagent is running a command"]);
  });
  test("a tool with no phrase is still said, by its own name", () => {
    expect(phraseFor("Bash")).toBe("running a command");
    expect(phraseFor("SomethingNew")).toBe("using SomethingNew");
  });
  test("the narration belongs to one turn", () => {
    const n = new Narrator(config);
    n.started("t1", "Bash", null, 0);
    n.turnEnded();
    expect(n.due(10_000)).toEqual([]);
  });
});
