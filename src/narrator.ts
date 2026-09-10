/**
 * What the bridge says while a turn runs (spec 2.3), so a long turn does not
 * sound like a dropped call.
 *
 * Spec 7.1 once put this in a hook inside aleph, on the assumption that the
 * bridge could not see which tool was about to run. Claude Code 2.1.267 puts
 * every tool call on the same stream the bridge already reads, subagent calls
 * included, so 7.1 is removed and the narration lives here — which is also
 * where 3.4 and 6.5 say a voice decision belongs.
 *
 * Only a call that outlives the delay is worth saying (15.5). A quick read
 * stays silent, and one phrase covers a subagent for as long as it runs.
 */
import type { Config } from "./config.ts";

/** One phrase per tool. A name with no entry is still worth saying, by its own name. */
const PHRASES: Record<string, string> = {
  Agent: "starting a subagent",
  Task: "starting a subagent",
  Bash: "running a command",
  Read: "reading a file",
  Edit: "changing a file",
  Write: "writing a file",
  NotebookEdit: "changing a notebook",
  Grep: "searching the code",
  Glob: "looking for files",
  WebFetch: "reading a page",
  WebSearch: "searching the web",
  Skill: "using a skill",
};

export function phraseFor(tool: string): string {
  return PHRASES[tool] ?? `using ${tool}`;
}

interface Call {
  tool: string;
  parentId: string | null;
  startedAt: number;
  spoken: boolean;
}

export class Narrator {
  private calls = new Map<string, Call>();

  constructor(private readonly config: Config) {}

  started(id: string, tool: string, parentId: string | null, now: number): void {
    this.calls.set(id, { tool, parentId, startedAt: now, spoken: false });
  }

  ended(id: string): void {
    this.calls.delete(id);
  }

  /** 8.6.10 the narration belongs to one turn, like the ceiling. */
  turnEnded(): void {
    this.calls.clear();
  }

  /**
   * The phrases to say now: one per call that has run longer than the delay and
   * has not been said yet. A call inside a subagent says so, because otherwise
   * two levels of work sound like one.
   */
  due(now: number): string[] {
    const out: string[] = [];
    for (const call of this.calls.values()) {
      if (call.spoken || now - call.startedAt < this.config.narrationDelayMs) continue;
      call.spoken = true;
      const phrase = phraseFor(call.tool);
      out.push(call.parentId === null ? phrase : `the subagent is ${phrase}`);
    }
    return out;
  }
}
