import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAnthropicStreamEvent,
  createAnthropicStreamState,
  finishAnthropicStream,
} from "../../src/adapters/providers/anthropic-provider.ts";
import {
  applyChatStreamData,
  createChatStreamState,
  finishChatStream,
} from "../../src/adapters/providers/openai-chat-provider.ts";
import {
  applyResponsesStreamEvent,
  createResponsesStreamState,
  finishResponsesStream,
} from "../../src/adapters/providers/openai-responses-provider.ts";
import type { ProviderDelta } from "../../src/ports/model-provider.ts";

function deltas(): { text: string; onDelta: (delta: ProviderDelta) => void } {
  const state = { text: "" };
  return {
    get text() {
      return state.text;
    },
    onDelta: (delta) => {
      state.text += delta.text;
    },
  };
}

describe("OpenAI Chat streaming", () => {
  it("accumulates text, usage and completion", () => {
    const state = createChatStreamState();
    const seen = deltas();
    applyChatStreamData(state, '{"choices":[{"delta":{"content":"hel"}}]}', seen.onDelta);
    applyChatStreamData(
      state,
      '{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      seen.onDelta,
    );
    applyChatStreamData(state, '{"usage":{"prompt_tokens":5,"completion_tokens":2}}', seen.onDelta);
    applyChatStreamData(state, "[DONE]", seen.onDelta);

    assert.equal(seen.text, "hello");
    assert.deepEqual(finishChatStream(state), {
      kind: "completed",
      toolCalls: [],
      text: "hello",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it("assembles tool-call fragments only after the stream ends", () => {
    const state = createChatStreamState();
    const seen = deltas();
    applyChatStreamData(
      state,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      seen.onDelta,
    );
    applyChatStreamData(
      state,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
      seen.onDelta,
    );
    applyChatStreamData(state, "[DONE]", seen.onDelta);

    assert.deepEqual(finishChatStream(state), {
      kind: "completed",
      toolCalls: [
        { providerToolCallId: "call_1", toolName: "read_file", arguments: { path: "a.ts" } },
      ],
      text: null,
    });
  });

  it("rejects malformed tool arguments instead of passing an empty object", () => {
    const state = createChatStreamState();
    const seen = deltas();
    applyChatStreamData(
      state,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{"}}]},"finish_reason":"tool_calls"}]}',
      seen.onDelta,
    );
    applyChatStreamData(state, "[DONE]", seen.onDelta);
    assert.deepEqual(finishChatStream(state), {
      kind: "invalid_response",
      safeCode: "openai_chat_arguments_not_json",
    });
  });

  it("rejects a stream that ends without a completion marker", () => {
    const state = createChatStreamState();
    const seen = deltas();
    applyChatStreamData(state, '{"choices":[{"delta":{"content":"partial"}}]}', seen.onDelta);
    assert.deepEqual(finishChatStream(state), {
      kind: "invalid_response",
      safeCode: "openai_chat_stream_incomplete",
    });
  });
});

describe("Anthropic streaming", () => {
  function event(name: string, data: unknown) {
    return { event: name, data: JSON.stringify(data), id: null };
  }

  it("accumulates text and usage across message events", () => {
    const state = createAnthropicStreamState();
    const seen = deltas();
    applyAnthropicStreamEvent(
      state,
      event("message_start", {
        type: "message_start",
        message: {
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2 },
        },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(state, event("message_stop", { type: "message_stop" }), seen.onDelta);

    assert.equal(seen.text, "hello");
    assert.deepEqual(finishAnthropicStream(state), {
      kind: "completed",
      toolCalls: [],
      text: "hello",
      usage: { inputTokens: 7, outputTokens: 2, cachedInputTokens: 2 },
    });
  });

  it("assembles tool-use JSON fragments", () => {
    const state = createAnthropicStreamState();
    const seen = deltas();
    applyAnthropicStreamEvent(
      state,
      event("message_start", { type: "message_start", message: { usage: {} } }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
      }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(state, event("message_stop", { type: "message_stop" }), seen.onDelta);

    assert.deepEqual(finishAnthropicStream(state), {
      kind: "completed",
      toolCalls: [
        { providerToolCallId: "toolu_1", toolName: "read_file", arguments: { path: "a.ts" } },
      ],
      text: null,
    });
  });

  it("rejects a truncated response", () => {
    const state = createAnthropicStreamState();
    const seen = deltas();
    applyAnthropicStreamEvent(
      state,
      event("message_start", { type: "message_start", message: { usage: {} } }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(
      state,
      event("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }),
      seen.onDelta,
    );
    applyAnthropicStreamEvent(state, event("message_stop", { type: "message_stop" }), seen.onDelta);
    assert.deepEqual(finishAnthropicStream(state), {
      kind: "invalid_response",
      safeCode: "anthropic_truncated",
    });
  });
});

describe("OpenAI Responses streaming", () => {
  function event(name: string, data: unknown) {
    return { event: name, data: JSON.stringify(data), id: null };
  }

  it("forwards text deltas and uses the completed response as the completion", () => {
    const state = createResponsesStreamState();
    const seen = deltas();
    applyResponsesStreamEvent(
      state,
      event("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "hel",
      }),
      seen.onDelta,
    );
    applyResponsesStreamEvent(
      state,
      event("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "lo",
      }),
      seen.onDelta,
    );
    applyResponsesStreamEvent(
      state,
      event("response.completed", {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "hello" }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      }),
      seen.onDelta,
    );

    assert.equal(seen.text, "hello");
    assert.deepEqual(finishResponsesStream(state), {
      kind: "completed",
      toolCalls: [],
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("rejects an incomplete response", () => {
    const state = createResponsesStreamState();
    const seen = deltas();
    applyResponsesStreamEvent(
      state,
      event("response.incomplete", { type: "response.incomplete" }),
      seen.onDelta,
    );
    assert.deepEqual(finishResponsesStream(state), {
      kind: "invalid_response",
      safeCode: "openai_responses_incomplete",
    });
  });

  it("rejects a stream without a completed response", () => {
    const state = createResponsesStreamState();
    const seen = deltas();
    applyResponsesStreamEvent(
      state,
      event("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "partial",
      }),
      seen.onDelta,
    );
    assert.deepEqual(finishResponsesStream(state), {
      kind: "invalid_response",
      safeCode: "openai_responses_stream_incomplete",
    });
  });
});
