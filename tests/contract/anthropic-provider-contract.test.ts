import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANTHROPIC_DEFAULTS,
  AnthropicProvider,
  buildRequestBody,
  interpretMessageResponse,
} from "../../src/adapters/providers/anthropic-provider.ts";
import type {
  ProviderHttpRequest,
  ProviderHttpResult,
} from "../../src/adapters/providers/provider-http.ts";
import { providerHttpsPost } from "../../src/adapters/providers/provider-http.ts";
import type { ProviderConversationItem } from "../../src/ports/model-provider.ts";

type Captured = ProviderHttpRequest;

function capture(result: ProviderHttpResult) {
  const calls: Captured[] = [];
  return {
    calls,
    post: async (input: Captured): Promise<ProviderHttpResult> => {
      calls.push(input);
      return result;
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true as const,
    status,
    headers,
    bodyText: JSON.stringify(body),
    wireBytes: 0,
  };
}

function provider(
  post: (input: Captured) => Promise<ProviderHttpResult>,
  options: {
    tools?: Parameters<typeof buildRequestBody>[0]["tools"];
    system?: string;
    apiKey?: string | null;
  } = {},
) {
  return new AnthropicProvider({
    resolveApiKey: async () => (options.apiKey === undefined ? "test-key-value" : options.apiKey),
    model: "claude-test-model",
    post,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.system === undefined ? {} : { system: options.system }),
  });
}

const SIMPLE_REQUEST = {
  modelRequestId: "req-1",
  attemptNo: 1,
  conversation: [{ kind: "user" as const, text: "hello" }],
};

describe("anthropic request construction", () => {
  it("serializes explicit effort in output_config and leaves default unspecified", () => {
    for (const reasoningEffort of ["default", "low", "medium", "high", "xhigh", "max"] as const) {
      const body = buildRequestBody(
        { resolveApiKey: async () => null, model: "model", reasoningEffort },
        SIMPLE_REQUEST.conversation,
      );
      assert.deepEqual(
        body["output_config"],
        reasoningEffort === "default" ? undefined : { effort: reasoningEffort },
      );
      assert.equal(body["thinking"], undefined);
      assert.equal(body["reasoning"], undefined);
    }
  });

  it("rejects OpenAI-only effort values before reading credentials or sending", async () => {
    for (const reasoningEffort of ["none", "minimal"] as const) {
      let accessed = false;
      const adapter = new AnthropicProvider({
        model: "model",
        reasoningEffort,
        resolveApiKey: async () => {
          accessed = true;
          return "fixture";
        },
        post: async () => {
          throw new Error("must not send");
        },
      });
      assert.equal((await adapter.complete(SIMPLE_REQUEST)).kind, "invalid_response");
      assert.equal(accessed, false);
    }
  });

  it("sends the credential as a header and never in the body", async () => {
    const { calls, post } = capture(jsonResponse(200, { content: [{ type: "text", text: "hi" }] }));
    const secret = "sk-ant-test-secret";
    await provider(post, { apiKey: secret }).complete(SIMPLE_REQUEST);

    const sent = calls[0];
    assert.ok(sent);
    assert.equal(sent.headers["x-api-key"], secret);
    assert.equal(sent.bodyText.includes(secret), false, "key must not appear in the body");
    assert.equal(sent.url, ANTHROPIC_DEFAULTS.endpoint);
    assert.equal(sent.headers["anthropic-version"], ANTHROPIC_DEFAULTS.apiVersion);
    assert.equal(sent.headers["content-type"], "application/json");
  });

  it("does not send when the credential is missing", async () => {
    const { calls, post } = capture(jsonResponse(200, { content: [] }));
    const completion = await provider(post, { apiKey: null }).complete(SIMPLE_REQUEST);
    assert.deepEqual(completion, {
      kind: "authentication_failure",
      safeCode: "anthropic_key_not_configured",
    });
    assert.equal(calls.length, 0, "nothing may be sent without a credential");
  });

  it("does not send when the credential resolver throws", async () => {
    const { calls, post } = capture(jsonResponse(200, { content: [] }));
    const adapter = new AnthropicProvider({
      resolveApiKey: async () => {
        throw new Error("vault_unavailable");
      },
      model: "claude-test-model",
      post,
    });
    const completion = await adapter.complete(SIMPLE_REQUEST);
    assert.equal(completion.kind, "authentication_failure");
    assert.equal(calls.length, 0);
  });

  it("carries an assistant turn with its tool_use blocks", () => {
    const conversation: readonly ProviderConversationItem[] = [
      { kind: "user", text: "read a file" },
      {
        kind: "assistant",
        text: "ok",
        toolCalls: [
          { providerToolCallId: "call-1", toolName: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      {
        kind: "tool_result",
        providerToolCallId: "call-1",
        toolName: "read_file",
        status: "succeeded",
        text: "body",
      },
    ];
    const body = buildRequestBody({ resolveApiKey: async () => null, model: "m" }, conversation);
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.equal(messages.length, 3);

    const assistant = messages[1];
    assert.ok(assistant);
    assert.equal(assistant["role"], "assistant");
    const assistantContent = assistant["content"] as readonly Record<string, unknown>[];
    assert.deepEqual(assistantContent[0], { type: "text", text: "ok" });
    assert.deepEqual(assistantContent[1], {
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "a.ts" },
    });

    const toolResult = messages[2];
    assert.ok(toolResult);
    assert.equal(toolResult["role"], "user");
    assert.deepEqual((toolResult["content"] as readonly unknown[])[0], {
      type: "tool_result",
      tool_use_id: "call-1",
      is_error: false,
      content: "body",
    });
  });

  it("marks a denied tool result as an error", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ providerToolCallId: "c", toolName: "shell", arguments: {} }],
      },
      {
        kind: "tool_result",
        providerToolCallId: "c",
        toolName: "shell",
        status: "denied",
        text: null,
      },
    ];
    const body = buildRequestBody({ resolveApiKey: async () => null, model: "m" }, conversation);
    const messages = body["messages"] as readonly Record<string, unknown>[];
    const result = (messages[1]?.["content"] as readonly Record<string, unknown>[])[0];
    assert.equal(result?.["is_error"], true);
  });

  it("omits an assistant turn that has neither text nor calls", () => {
    const conversation: readonly ProviderConversationItem[] = [
      { kind: "assistant", text: null, toolCalls: [] },
      { kind: "user", text: "continue" },
    ];
    const body = buildRequestBody({ resolveApiKey: async () => null, model: "m" }, conversation);
    const messages = body["messages"] as readonly Record<string, unknown>[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.["role"], "user");
  });

  it("passes tool definitions through unchanged", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const body = buildRequestBody({ resolveApiKey: async () => null, model: "m", tools }, [
      { kind: "user", text: "x" },
    ]);
    assert.deepEqual(body["tools"], [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("declares no tools when the list is empty", () => {
    const body = buildRequestBody({ resolveApiKey: async () => null, model: "m", tools: [] }, [
      { kind: "user", text: "x" },
    ]);
    assert.equal(body["tools"], undefined);
  });

  it("includes a system prompt only when one is configured", () => {
    const withSystem = buildRequestBody(
      { resolveApiKey: async () => null, model: "m", system: "be careful" },
      [{ kind: "user", text: "x" }],
    );
    assert.equal(withSystem["system"], "be careful");

    const without = buildRequestBody({ resolveApiKey: async () => null, model: "m" }, [
      { kind: "user", text: "x" },
    ]);
    assert.equal(without["system"], undefined);
  });
});

describe("anthropic response interpretation", () => {
  it("extracts text and tool calls", () => {
    const completion = interpretMessageResponse(
      JSON.stringify({
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.equal(completion.text, "looking");
    assert.deepEqual(completion.toolCalls, [
      { providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } },
    ]);
  });

  it("returns null text when the response has no text block", () => {
    const completion = interpretMessageResponse(
      JSON.stringify({ content: [{ type: "tool_use", id: "c", name: "t", input: {} }] }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.equal(completion.text, null);
  });

  it("ignores thinking blocks", () => {
    const completion = interpretMessageResponse(
      JSON.stringify({
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: "answer" },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.equal(completion.text, "answer");
    assert.deepEqual(completion.toolCalls, []);
  });

  it("rejects a non-JSON body", () => {
    assert.deepEqual(interpretMessageResponse("<html>"), {
      kind: "invalid_response",
      safeCode: "anthropic_body_not_json",
    });
  });

  it("rejects a JSON array root", () => {
    assert.deepEqual(interpretMessageResponse("[]"), {
      kind: "invalid_response",
      safeCode: "anthropic_body_not_object",
    });
  });

  it("rejects an error payload delivered with a 2xx status", () => {
    assert.deepEqual(interpretMessageResponse(JSON.stringify({ type: "error" })), {
      kind: "invalid_response",
      safeCode: "anthropic_error_payload",
    });
  });

  it("rejects a missing content array", () => {
    assert.deepEqual(interpretMessageResponse(JSON.stringify({})), {
      kind: "invalid_response",
      safeCode: "anthropic_content_missing",
    });
  });

  it("rejects an unknown block type instead of skipping it", () => {
    assert.deepEqual(interpretMessageResponse(JSON.stringify({ content: [{ type: "mystery" }] })), {
      kind: "invalid_response",
      safeCode: "anthropic_block_unknown",
    });
  });

  it("rejects a tool_use without an id", () => {
    assert.deepEqual(
      interpretMessageResponse(JSON.stringify({ content: [{ type: "tool_use", name: "t" }] })),
      { kind: "invalid_response", safeCode: "anthropic_tool_use_invalid" },
    );
  });

  it("rejects a text block without text", () => {
    assert.deepEqual(interpretMessageResponse(JSON.stringify({ content: [{ type: "text" }] })), {
      kind: "invalid_response",
      safeCode: "anthropic_text_invalid",
    });
  });
});

describe("anthropic error mapping", () => {
  async function statusOutcome(status: number, headers: Record<string, string> = {}) {
    const { post } = capture(jsonResponse(status, {}, headers));
    return provider(post).complete(SIMPLE_REQUEST);
  }

  it("maps 401 to an authentication failure", async () => {
    assert.deepEqual(await statusOutcome(401), {
      kind: "authentication_failure",
      safeCode: "anthropic_unauthorized",
    });
  });

  it("maps 403 to an authentication failure", async () => {
    assert.equal((await statusOutcome(403)).kind, "authentication_failure");
  });

  it("maps 429 to a transient failure honouring Retry-After", async () => {
    assert.deepEqual(await statusOutcome(429, { "retry-after": "3" }), {
      kind: "transient_failure",
      safeCode: "anthropic_rate_limited",
      retryAfterMs: 3000,
    });
  });

  it("maps 5xx to a transient failure", async () => {
    assert.deepEqual(await statusOutcome(503), {
      kind: "transient_failure",
      safeCode: "anthropic_server_error",
    });
  });

  it("maps a redirect to an invalid response and never follows it", async () => {
    assert.deepEqual(await statusOutcome(302), {
      kind: "invalid_response",
      safeCode: "anthropic_unexpected_redirect",
    });
  });

  it("maps other 4xx to an invalid response", async () => {
    assert.deepEqual(await statusOutcome(400), {
      kind: "invalid_response",
      safeCode: "anthropic_request_rejected",
    });
  });

  it("clamps a hostile Retry-After", async () => {
    const outcome = await statusOutcome(429, { "retry-after": "999999" });
    assert.equal(outcome.kind, "transient_failure");
    if (outcome.kind !== "transient_failure") return;
    assert.equal(outcome.retryAfterMs, 60_000);
  });
});

describe("anthropic transport failure mapping", () => {
  async function transportOutcome(code: string) {
    const { post } = capture({ ok: false, code: code as never });
    return provider(post).complete(SIMPLE_REQUEST);
  }

  it("treats a timeout as transient", async () => {
    assert.equal((await transportOutcome("timeout")).kind, "transient_failure");
  });

  it("treats a connect failure as transient", async () => {
    assert.equal((await transportOutcome("connect_failed")).kind, "transient_failure");
  });

  it("treats a TLS failure as transient", async () => {
    assert.equal((await transportOutcome("tls_failed")).kind, "transient_failure");
  });

  it("treats an oversized response as invalid, not transient", async () => {
    assert.equal((await transportOutcome("response_too_large")).kind, "invalid_response");
  });

  it("treats an invalid endpoint as invalid, not transient", async () => {
    assert.equal((await transportOutcome("invalid_endpoint")).kind, "invalid_response");
  });
});

describe("provider http endpoint handling", () => {
  it("rejects a non-https endpoint", async () => {
    const result = await providerHttpsPost({
      url: "http://api.example.com/v1/messages",
      headers: {},
      bodyText: "{}",
    });
    assert.deepEqual(result, { ok: false, code: "invalid_endpoint" });
  });

  it("rejects userinfo in the endpoint URL", async () => {
    const result = await providerHttpsPost({
      url: "https://user:pass@api.example.com/v1/messages",
      headers: {},
      bodyText: "{}",
    });
    assert.deepEqual(result, { ok: false, code: "invalid_endpoint" });
  });

  it("rejects an unparseable endpoint", async () => {
    const result = await providerHttpsPost({ url: "not a url", headers: {}, bodyText: "{}" });
    assert.deepEqual(result, { ok: false, code: "invalid_endpoint" });
  });

  it("rejects a request body above the cap before connecting", async () => {
    const result = await providerHttpsPost({
      url: "https://api.example.com/v1/messages",
      headers: {},
      bodyText: "x".repeat(8 * 1024 * 1024 + 1),
    });
    assert.deepEqual(result, { ok: false, code: "request_too_large" });
  });
});
