/**
 * Claude Code's stream-json output, reduced to what the bridge acts on.
 *
 * Shapes confirmed against claude 2.1.267 with
 *   -p --verbose --input-format stream-json --output-format stream-json
 * Anything unrecognised still counts as activity, which is the point: the
 * silence detector must not go blind when a new event type appears.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type Event =
  | { kind: "init"; sessionId: string; model: string }
  /** the context window and the compaction threshold, in tokens */
  | { kind: "context"; window: number; threshold: number; enabled: boolean }
  | { kind: "rateLimit"; fiveHour: number; sevenDay: number; resetsAt: number }
  | { kind: "text"; text: string }
  | { kind: "toolStart"; id: string; tool: string }
  | { kind: "toolEnd"; id: string }
  | { kind: "compaction" }
  | { kind: "result"; text: string; costUsd: number; usage: Usage; isError: boolean }
  | { kind: "other"; type: string };

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usageOf(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
  };
}

/** The tokens that count against the context window: everything the model read, plus what it wrote. */
export function contextTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens;
}

/** One line of NDJSON becomes zero or more events; one assistant message can carry both text and a tool call. */
export function parseLine(line: string): Event[] {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return []; }
  const type = typeof raw.type === "string" ? raw.type : "";
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";

  // a compaction can arrive as its own event or as a system subtype; match on the word
  if (type.includes("compact") && type !== "autocompact_state") return [{ kind: "compaction" }];
  if (subtype.includes("compact")) return [{ kind: "compaction" }];

  if (type === "autocompact_state") {
    const v = (raw.value ?? {}) as Record<string, unknown>;
    return [{ kind: "context", window: num(v.effective_window), threshold: num(v.threshold), enabled: v.enabled === true }];
  }
  if (type === "rate_limit_event") {
    const info = (raw.rate_limit_info ?? {}) as Record<string, unknown>;
    const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
    return [{
      kind: "rateLimit",
      fiveHour: num(windows.five_hour?.utilization),
      sevenDay: num(windows.seven_day?.utilization),
      resetsAt: num(info.resetsAt),
    }];
  }
  if (type === "system" && subtype === "init") {
    return [{ kind: "init", sessionId: String(raw.session_id ?? ""), model: String(raw.model ?? "") }];
  }
  if (type === "result") {
    return [{
      kind: "result",
      text: typeof raw.result === "string" ? raw.result : "",
      costUsd: num(raw.total_cost_usd),
      usage: usageOf(raw.usage),
      isError: raw.is_error === true,
    }];
  }
  if (type === "assistant" || type === "user") {
    const message = (raw.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    const out: Event[] = [];
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === "text" && typeof part.text === "string") out.push({ kind: "text", text: part.text });
      else if (part?.type === "tool_use") out.push({ kind: "toolStart", id: String(part.id ?? ""), tool: String(part.name ?? "") });
      else if (part?.type === "tool_result") out.push({ kind: "toolEnd", id: String(part.tool_use_id ?? "") });
    }
    return out.length ? out : [{ kind: "other", type }];
  }
  return [{ kind: "other", type: type || "unknown" }];
}

/** Split a stream into whole lines, holding the tail until its newline arrives. */
export class LineSplitter {
  private buffer = "";
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim());
  }
}
