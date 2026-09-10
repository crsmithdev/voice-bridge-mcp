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
  /** 5.5 the reply word by word, so 5.6 can collect it to a sentence and speak it */
  | { kind: "delta"; text: string }
  /** 8.6.5 the receipt for a control request; still_queued names the turns it dropped */
  | { kind: "controlResponse"; ok: boolean; stillQueued: string[] }
  /** parentId names the Agent call this one runs inside, or null at the top level */
  | { kind: "toolStart"; id: string; tool: string; parentId: string | null }
  | { kind: "toolEnd"; id: string; parentId: string | null }
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
  // --include-partial-messages streams the reply as text deltas and repeats it whole
  // in the assistant message that follows. Only the whole message becomes "text",
  // so the reply is never counted twice; the deltas are the voice path.
  if (type === "stream_event") {
    const event = (raw.event ?? {}) as Record<string, unknown>;
    const delta = (event.delta ?? {}) as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") return [{ kind: "delta", text: delta.text }];
    return [{ kind: "other", type: `stream_event.${String(event.type ?? "")}` }];
  }
  if (type === "control_response") {
    const response = (raw.response ?? {}) as Record<string, unknown>;
    const inner = (response.response ?? {}) as Record<string, unknown>;
    const queued = Array.isArray(inner.still_queued) ? inner.still_queued.map(String) : [];
    return [{ kind: "controlResponse", ok: response.subtype === "success", stillQueued: queued }];
  }
  if (type === "assistant" || type === "user") {
    const message = (raw.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    // a subagent's own tool calls arrive on this same stream, named by the Agent
    // call they run inside, so the bridge never goes blind inside a subagent
    const parentId = typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null;
    const out: Event[] = [];
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === "text" && typeof part.text === "string") out.push({ kind: "text", text: part.text });
      else if (part?.type === "tool_use") out.push({ kind: "toolStart", id: String(part.id ?? ""), tool: String(part.name ?? ""), parentId });
      else if (part?.type === "tool_result") out.push({ kind: "toolEnd", id: String(part.tool_use_id ?? ""), parentId });
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
