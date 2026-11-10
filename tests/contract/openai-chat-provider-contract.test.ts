import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChatRequestBody,
  interpretChatResponse,
  OPENAI_CHAT_DEFAULTS,
  OpenAiChatProvider,
} from "../../src/adapters/providers/openai-chat-provider.ts";
import type {
  ProviderHttpRequest,
  ProviderHttpResult,
} from "../../src/adapters/providers/provider-http.ts";
import type { ProviderConversationItem } from "../../src/ports/model-provider.ts";

function capture(result: ProviderHttpResult) {
  const calls: ProviderHttpRequest[] = [];
  return {
    calls,
    post: async (input: ProviderHttpRequest): Promise<ProviderHttpResult> => {
      calls.push(input);
      return result;
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: true as const, status, headers, bodyText: JSON.stringify(body), wireBytes: 0 };
}

function provider(
  post: (input: ProviderHttpRequest) => Promise<ProviderHttpResult>,
  options: {
    apiKey?: string | null;
    tools?: Parameters<typeof buildChatRequestBody>[0]["tools"];
  } = {},
) {
  return new OpenAiChatProvider({
    resolveApiKey: async () => (options.apiKey === undefined ? "test-key" : options.apiKey),
    model: "gpt-test",
    baseUrl: "https://api.example.com",
    post,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
}

const REQUEST = {
  modelRequestId: "r1",
  attemptNo: 1,
  conversation: [{ kind: "user" as const, text: "hello" }],
};

describe("openai chat request construction", () => {
  it("sends explicit reasoning effort with a completion-token budget", () => {
    const body = buildChatRequestBody(
      {
        resolveApiKey: async () => null,
        model: "reasoning-model",
        baseUrl: "https://x",
        reasoningEffort: "high",
        maxTokens: 8192,
      },
      [],
    );
    assert.equal(body["reasoning_effort"], "high");
    assert.equal(body["max_completion_tokens"], 8192);
    assert.equal("max_tokens" in body, false);
    const defaults = buildChatRequestBody(
      {
        resolveApiKey: async () => null,
        model: "m",
        baseUrl: "https://x",
        reasoningEffort: "default",
      },
      [],
    );
    assert.equal("reasoning_effort" in defaults, false);
  });

  it("posts to the chat completions path with a bearer credential", async () => {
    const { calls, post } = capture(
      jsonResponse(200, { choices: [{ message: { content: "hi" } }] }),
    );
    await provider(post, { apiKey: "sk-test" }).complete(REQUEST);

    const sent = calls[0];
    assert.ok(sent);
    assert.equal(sent.url, `https://api.example.com${OPENAI_CHAT_DEFAULTS.path}`);
    assert.equal(sent.headers["authorization"], "Bearer sk-test");
    assert.equal(sent.bodyText.includes("sk-test"), false, "key must not appear in the body");
  });

  it("does not send without a credential", async () => {
    const { calls, post } = capture(jsonResponse(200, { choices: [] }));
    const completion = await provider(post, { apiKey: null }).complete(REQUEST);
    assert.deepEqual(completion, {
      kind: "authentication_failure",
      safeCode: "openai_chat_key_not_configured",
    });
    assert.equal(calls.length, 0);
  });

  it("puts the system prompt in a system message", () => {
    const body = buildChatRequestBody(
      { resolveApiKey: async () => null, model: "m", baseUrl: "https://x", system: "rules" },
      [{ kind: "user", text: "go" }],
    );
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.deepEqual(messages[0], { role: "system", content: "rules" });
    assert.deepEqual(messages[1], { role: "user", content: "go" });
  });

  it("serializes tool arguments as a JSON string", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "assistant",
        text: null,
        toolCalls: [
          { providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } },
        ],
      },
    ];
    const body = buildChatRequestBody(
      { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
      conversation,
    );
    const messages = body["messages"] as readonly Record<string, unknown>[];
    const assistant = messages[0];
    assert.ok(assistant);
    const toolCalls = assistant["tool_calls"] as readonly Record<string, unknown>[];
    assert.equal(toolCalls.length, 1);
    const fn = toolCalls[0]?.["function"] as Record<string, unknown>;
    assert.equal(fn["arguments"], JSON.stringify({ path: "a.ts" }));
    assert.equal(typeof fn["arguments"], "string");
  });

  it("serializes empty arguments as an empty JSON object, not an empty string", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ providerToolCallId: "c1", toolName: "todo", arguments: undefined }],
      },
    ];
    const body = buildChatRequestBody(
      { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
      conversation,
    );
    const messages = body["messages"] as readonly Record<string, unknown>[];
    const toolCalls = messages[0]?.["tool_calls"] as readonly Record<string, unknown>[];
    const fn = toolCalls[0]?.["function"] as Record<string, unknown>;
    assert.equal(fn["arguments"], "{}");
  });

  it("sends a tool result as its own tool message keyed by call id", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "read_file",
        status: "succeeded",
        text: "body",
      },
    ];
    const body = buildChatRequestBody(
      { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
      conversation,
    );
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.deepEqual(messages[0], { role: "tool", tool_call_id: "c1", content: "body" });
  });

  it("marks a failed tool result in the text so the model knows", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "shell",
        status: "denied",
        text: null,
      },
    ];
    const body = buildChatRequestBody(
      { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" },
      conversation,
    );
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.match(String(messages[0]?.["content"]), /denied/);
  });

  it("wraps tool definitions in the function envelope", () => {
    const body = buildChatRequestBody(
      {
        resolveApiKey: async () => null,
        model: "m",
        baseUrl: "https://x",
        tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      },
      [{ kind: "user", text: "go" }],
    );
    assert.deepEqual(body["tools"], [
      {
        type: "function",
        function: { name: "read_file", description: "Read", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("openai chat response interpretation", () => {
  it("extracts text", () => {
    const completion = interpretChatResponse(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
    );
    assert.deepEqual(completion, { kind: "completed", toolCalls: [], text: "hello" });
  });

  it("parses tool calls and their JSON arguments", () => {
    const completion = interpretChatResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.deepEqual(completion.toolCalls, [
      { providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } },
    ]);
    assert.equal(completion.text, null);
  });

  it("treats an empty arguments string as no arguments", () => {
    const completion = interpretChatResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "todo", arguments: "" } }],
            },
          },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.deepEqual(completion.toolCalls[0]?.arguments, {});
  });

  it("rejects malformed argument JSON rather than substituting an empty object", () => {
    const completion = interpretChatResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "x", arguments: "{not json" } }],
            },
          },
        ],
      }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_chat_arguments_not_json",
    });
  });

  it("rejects a truncated turn so its tool calls cannot execute", () => {
    const completion = interpretChatResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }],
            },
          },
        ],
      }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_chat_truncated",
    });
  });

  it("rejects a content-filtered turn", () => {
    const completion = interpretChatResponse(
      JSON.stringify({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
    );
    assert.equal(completion.kind, "invalid_response");
    if (completion.kind !== "invalid_response") return;
    assert.equal(completion.safeCode, "openai_chat_content_filtered");
  });

  it("rejects an error payload", () => {
    const completion = interpretChatResponse(JSON.stringify({ error: { message: "bad request" } }));
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_chat_error_payload",
    });
  });

  it("rejects a missing choices array", () => {
    assert.deepEqual(interpretChatResponse("{}"), {
      kind: "invalid_response",
      safeCode: "openai_chat_choices_missing",
    });
  });

  it("rejects a non-JSON body", () => {
    assert.deepEqual(interpretChatResponse("<html>"), {
      kind: "invalid_response",
      safeCode: "openai_chat_body_not_json",
    });
  });

  it("rejects a non-string, non-null content", () => {
    const completion = interpretChatResponse(
      JSON.stringify({ choices: [{ message: { content: [{ type: "text" }] } }] }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_chat_content_invalid",
    });
  });
});

describe("openai chat status mapping", () => {
  async function outcome(status: number, headers: Record<string, string> = {}) {
    const { post } = capture(jsonResponse(status, {}, headers));
    return provider(post).complete(REQUEST);
  }

  it("maps 401 to authentication failure", async () => {
    assert.deepEqual(await outcome(401), {
      kind: "authentication_failure",
      safeCode: "openai_chat_unauthorized",
    });
  });

  it("maps 429 to a transient failure with Retry-After", async () => {
    const result = await outcome(429, { "retry-after": "2" });
    assert.equal(result.kind, "transient_failure");
    if (result.kind !== "transient_failure") return;
    assert.equal(result.retryAfterMs, 2000);
  });

  it("maps 5xx to a transient failure", async () => {
    assert.equal((await outcome(500)).kind, "transient_failure");
  });

  it("maps a redirect to an invalid response", async () => {
    assert.deepEqual(await outcome(302), {
      kind: "invalid_response",
      safeCode: "openai_chat_unexpected_redirect",
    });
  });

  it("maps other 4xx to an invalid response", async () => {
    assert.deepEqual(await outcome(400), {
      kind: "invalid_response",
      safeCode: "openai_chat_request_rejected",
    });
  });
});
