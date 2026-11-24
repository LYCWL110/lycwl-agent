import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AnthropicProvider,
  buildRequestBody,
} from "../../src/adapters/providers/anthropic-provider.ts";
import {
  buildChatRequestBody,
  OpenAiChatProvider,
} from "../../src/adapters/providers/openai-chat-provider.ts";
import {
  buildResponsesRequestBody,
  OpenAiResponsesProvider,
} from "../../src/adapters/providers/openai-responses-provider.ts";
import type {
  ProviderHttpRequest,
  ProviderHttpResult,
} from "../../src/adapters/providers/provider-http.ts";
import type { SseEvent } from "../../src/adapters/providers/provider-sse.ts";

function streamRecorder(events: readonly SseEvent[]) {
  const calls: ProviderHttpRequest[] = [];
  return {
    calls,
    streamPost: async (
      input: ProviderHttpRequest,
      onEvent: (event: SseEvent) => void,
    ): Promise<ProviderHttpResult> => {
      calls.push(input);
      for (const event of events) onEvent(event);
      return {
        ok: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyText: "",
        wireBytes: 0,
        eventStream: true,
      };
    },
  };
}

function jsonFallback(body: unknown) {
  const calls: ProviderHttpRequest[] = [];
  return {
    calls,
    streamPost: async (input: ProviderHttpRequest): Promise<ProviderHttpResult> => {
      calls.push(input);
      return {
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify(body),
        wireBytes: 0,
        eventStream: false,
      };
    },
  };
}

const REQUEST = {
  modelRequestId: "r1",
  attemptNo: 1,
  conversation: [{ kind: "user" as const, text: "hello" }],
};

describe("provider streaming wiring", () => {
  it("streams Chat text and marks the request as streaming", async () => {
    const recorder = streamRecorder([
      { event: null, data: '{"choices":[{"delta":{"content":"hel"}}]}', id: null },
      {
        event: null,
        data: '{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
        id: null,
      },
      { event: null, data: "[DONE]", id: null },
    ]);
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "chat-model",
      baseUrl: "https://api.example.com",
      streamPost: recorder.streamPost,
    });
    const deltas: string[] = [];
    const completion = await provider.stream(REQUEST, (delta) => deltas.push(delta.text));

    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.deepEqual(completion, { kind: "completed", toolCalls: [], text: "hello" });
    assert.equal(recorder.calls[0]?.headers["accept"], "text/event-stream");
    const body = JSON.parse(recorder.calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    assert.equal(body["stream"], true);
  });

  it("falls back to the non-streaming Chat interpreter for a JSON response", async () => {
    const fallback = jsonFallback({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
    });
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "chat-model",
      baseUrl: "https://api.example.com",
      streamPost: fallback.streamPost,
    });
    const completion = await provider.stream(REQUEST, () => undefined);
    assert.deepEqual(completion, { kind: "completed", toolCalls: [], text: "hello" });
  });

  it("streams Anthropic text and tool calls", async () => {
    const recorder = streamRecorder([
      {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 4, output_tokens: 1 } },
        }),
        id: null,
      },
      {
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        id: null,
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        }),
        id: null,
      },
      {
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
        id: null,
      },
      {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        }),
        id: null,
      },
      {
        event: "message_stop",
        data: JSON.stringify({ type: "message_stop" }),
        id: null,
      },
    ]);
    const provider = new AnthropicProvider({
      resolveApiKey: async () => "key",
      model: "claude-test",
      streamPost: recorder.streamPost,
    });
    const deltas: string[] = [];
    const completion = await provider.stream(REQUEST, (delta) => deltas.push(delta.text));

    assert.deepEqual(deltas, ["hello"]);
    assert.deepEqual(completion, {
      kind: "completed",
      toolCalls: [],
      text: "hello",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    assert.equal(recorder.calls[0]?.headers["accept"], "text/event-stream");
    const body = JSON.parse(recorder.calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    assert.equal(body["stream"], true);
  });

  it("streams Responses text and uses the completed response", async () => {
    const recorder = streamRecorder([
      {
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.output_text.delta", delta: "hel" }),
        id: null,
      },
      {
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.output_text.delta", delta: "lo" }),
        id: null,
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        }),
        id: null,
      },
    ]);
    const provider = new OpenAiResponsesProvider({
      resolveApiKey: async () => "key",
      model: "responses-model",
      baseUrl: "https://api.example.com",
      streamPost: recorder.streamPost,
    });
    const deltas: string[] = [];
    const completion = await provider.stream(REQUEST, (delta) => deltas.push(delta.text));

    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.deepEqual(completion, {
      kind: "completed",
      toolCalls: [],
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    assert.equal(recorder.calls[0]?.headers["accept"], "text/event-stream");
    const body = JSON.parse(recorder.calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    assert.equal(body["stream"], true);
  });

  it("keeps the non-streaming body free of streaming fields", () => {
    assert.equal(
      "stream" in
        buildChatRequestBody(
          { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
          [],
        ),
      false,
    );
    assert.equal(
      "stream" in buildRequestBody({ resolveApiKey: async () => null, model: "m" }, []),
      false,
    );
    assert.equal(
      "stream" in
        buildResponsesRequestBody(
          { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
          [],
        ),
      false,
    );
  });
});
