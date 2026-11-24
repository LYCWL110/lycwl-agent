import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SSE_LIMITS,
  type SseEvent,
  SseParseError,
  SseParser,
} from "../../src/adapters/providers/provider-sse.ts";

function collect(): { events: SseEvent[]; parser: SseParser } {
  const events: SseEvent[] = [];
  return { events, parser: new SseParser((event) => events.push(event)) };
}

describe("SSE parser", () => {
  it("reads data and dispatches on a blank line", () => {
    const { events, parser } = collect();
    parser.push("data: hello\n\n");
    assert.deepEqual(events, [{ event: null, data: "hello", id: null }]);
  });

  it("joins multiple data fields with a newline", () => {
    const { events, parser } = collect();
    parser.push("data: first\ndata: second\n\n");
    assert.deepEqual(events, [{ event: null, data: "first\nsecond", id: null }]);
  });

  it("keeps event and id fields", () => {
    const { events, parser } = collect();
    parser.push("event: response.output_text.delta\nid: 7\ndata: {}\n\n");
    assert.deepEqual(events, [{ event: "response.output_text.delta", data: "{}", id: "7" }]);
  });

  it("accepts CRLF and bare CR line endings", () => {
    const { events, parser } = collect();
    parser.push("data: one\r\n\r\ndata: two\r\r\n");
    assert.deepEqual(events, [
      { event: null, data: "one", id: null },
      { event: null, data: "two", id: null },
    ]);
  });

  it("keeps state across chunk boundaries", () => {
    const { events, parser } = collect();
    parser.push("da");
    parser.push("ta: hel");
    parser.push("lo\n");
    assert.deepEqual(events, []);
    parser.push("\n");
    assert.deepEqual(events, [{ event: null, data: "hello", id: null }]);
  });

  it("handles a CRLF split across two chunks", () => {
    const { events, parser } = collect();
    parser.push("data: hello\r");
    assert.deepEqual(events, []);
    parser.push("\n\r\n");
    assert.deepEqual(events, [{ event: null, data: "hello", id: null }]);
  });

  it("ignores comments and frames with no data", () => {
    const { events, parser } = collect();
    parser.push(": keep-alive\n\nevent: ping\n\n");
    assert.deepEqual(events, []);
  });

  it("dispatches a pending event at end without a final blank line", () => {
    const { events, parser } = collect();
    parser.push("data: last");
    parser.end();
    assert.deepEqual(events, [{ event: null, data: "last", id: null }]);
  });

  it("rejects an event above the byte bound", () => {
    const { parser } = collect();
    const chunk = `data: ${"x".repeat(SSE_LIMITS.maxEventBytes)}\n\n`;
    assert.throws(() => parser.push(chunk), SseParseError);
  });

  it("does not treat a data-less event as an event", () => {
    const { events, parser } = collect();
    parser.push("event: only\n\n");
    assert.deepEqual(events, []);
  });
});
