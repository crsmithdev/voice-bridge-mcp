import { describe, expect, test } from "bun:test";
import { LineSplitter, contextTokens, parseLine } from "../src/protocol.ts";

// captured from claude 2.1.267, trimmed to the fields the bridge reads
const INIT = '{"type":"system","subtype":"init","session_id":"a7e0","model":"claude-sonnet-5"}';
const AUTOCOMPACT = '{"type":"autocompact_state","value":{"enabled":true,"effective_window":980000,"threshold":784000}}';
const RATE = '{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1789002000,"unifiedWindows":{"five_hour":{"utilization":0.1},"seven_day":{"utilization":0.38}}}}';
const ASSISTANT = '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}';
const TOOL = '{"type":"assistant","message":{"content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"t1","name":"Bash"}]}}';
const TOOL_RESULT = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}';
const NESTED = '{"type":"assistant","parent_tool_use_id":"agent1","message":{"content":[{"type":"tool_use","id":"t9","name":"Bash"}]}}';
const DELTA = '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}}';
const THINKING = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}}';
const RECEIPT = '{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}';
const RESULT = '{"type":"result","subtype":"success","result":"pong","total_cost_usd":0.0385,"is_error":false,"usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":32936,"cache_creation_input_tokens":7744}}';

describe("protocol", () => {
  test("reads the session init", () => {
    expect(parseLine(INIT)).toEqual([{ kind: "init", sessionId: "a7e0", model: "claude-sonnet-5" }]);
  });
  test("reads the context window and threshold claude reports at start", () => {
    expect(parseLine(AUTOCOMPACT)).toEqual([{ kind: "context", window: 980000, threshold: 784000, enabled: true }]);
  });
  test("reads the rate limit utilization", () => {
    expect(parseLine(RATE)).toEqual([{ kind: "rateLimit", fiveHour: 0.1, sevenDay: 0.38, resetsAt: 1789002000 }]);
  });
  test("one message can carry text and a tool call", () => {
    expect(parseLine(TOOL)).toEqual([{ kind: "text", text: "looking" }, { kind: "toolStart", id: "t1", tool: "Bash", parentId: null }]);
    expect(parseLine(TOOL_RESULT)).toEqual([{ kind: "toolEnd", id: "t1", parentId: null }]);
  });
  test("a subagent's own tool calls arrive on the same stream, named by the Agent call", () => {
    expect(parseLine(NESTED)).toEqual([{ kind: "toolStart", id: "t9", tool: "Bash", parentId: "agent1" }]);
  });
  test("the result carries the reply, the cost and the usage", () => {
    const [event] = parseLine(RESULT);
    expect(event).toEqual({ kind: "result", text: "pong", costUsd: 0.0385, isError: false, usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 32936, cacheCreationTokens: 7744 } });
    if (event.kind === "result") expect(contextTokens(event.usage)).toBe(40686);
  });
  test("the reply streams as text deltas, and only the whole message counts as text", () => {
    expect(parseLine(DELTA)).toEqual([{ kind: "delta", text: "hello" }]);
    // the deltas repeat in the assistant message that follows, so the reply is not counted twice
    expect(parseLine(ASSISTANT)).toEqual([{ kind: "text", text: "pong" }]);
  });
  test("a thinking delta is not the reply", () => {
    expect(parseLine(THINKING)).toEqual([{ kind: "other", type: "stream_event.content_block_delta" }]);
  });
  test("the interrupt receipt says the process took it, and what it dropped", () => {
    expect(parseLine(RECEIPT)).toEqual([{ kind: "controlResponse", ok: true, stillQueued: [] }]);
    expect(parseLine('{"type":"control_response","response":{"subtype":"error","response":{"still_queued":["t2"]}}}'))
      .toEqual([{ kind: "controlResponse", ok: false, stillQueued: ["t2"] }]);
  });
  test("a compaction is matched by the word, wherever it appears", () => {
    expect(parseLine('{"type":"system","subtype":"compact_boundary"}')).toEqual([{ kind: "compaction" }]);
    expect(parseLine('{"type":"compaction"}')).toEqual([{ kind: "compaction" }]);
    // the state event announces the settings; it is not a compaction
    expect(parseLine(AUTOCOMPACT)[0].kind).toBe("context");
  });
  test("an unknown event is still an event, so silence detection does not go blind", () => {
    expect(parseLine('{"type":"something_new"}')).toEqual([{ kind: "other", type: "something_new" }]);
    expect(parseLine("not json")).toEqual([]);
  });
  test("assistant text accumulates in order", () => {
    expect(parseLine(ASSISTANT)).toEqual([{ kind: "text", text: "pong" }]);
  });
});

describe("line splitter", () => {
  test("holds a partial line until its newline arrives", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n')).toEqual(['{"b":2}']);
    expect(splitter.push("\n  \n")).toEqual([]);
  });
});
