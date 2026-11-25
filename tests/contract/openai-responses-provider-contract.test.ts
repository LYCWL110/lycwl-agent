import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildResponsesRequestBody,
  interpretResponsesResponse,
  OPENAI_RESPONSES_DEFAULTS,
  OpenAiResponsesProvider,
} from "../../src/adapters/providers/openai-responses-provider.ts";
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
  options: { apiKey?: string | null } = {},
) {
  return new OpenAiResponsesProvider({
    resolveApiKey: async () => (options.apiKey === undefined ? "test-key" : options.apiKey),
    model: "gpt-test",
    baseUrl: "https://api.example.com",
    post,
  });
}

const REQUEST = {
  modelRequestId: "r1",
  attemptNo: 1,
  conversation: [{ kind: "user" as const, text: "hello" }],
};

const BASE = { resolveApiKey: async () => null, model: "m", baseUrl: "https://x" };

describe("openai responses request construction", () => {
  it("sends reasoning effort only when explicitly selected", () => {
    assert.deepEqual(
      buildResponsesRequestBody({ ...BASE, reasoningEffort: "xhigh" }, [])["reasoning"],
      { effort: "xhigh" },
    );
    assert.equal("reasoning" in buildResponsesRequestBody(BASE, []), false);
    assert.equal(
      "reasoning" in buildResponsesRequestBody({ ...BASE, reasoningEffort: "default" }, []),
      false,
    );
  });

  it("posts to the responses path with a bearer credential", async () => {
    const { calls, post } = capture(jsonResponse(200, { status: "completed", output: [] }));
    await provider(post, { apiKey: "sk-test" }).complete(REQUEST);

    const sent = calls[0];
    assert.ok(sent);
    assert.equal(sent.url, `https://api.example.com${OPENAI_RESPONSES_DEFAULTS.path}`);
    assert.equal(sent.headers["authorization"], "Bearer sk-test");
    assert.equal(sent.bodyText.includes("sk-test"), false);
  });

  it("does not send without a credential", async () => {
    const { calls, post } = capture(jsonResponse(200, { output: [] }));
    const completion = await provider(post, { apiKey: null }).complete(REQUEST);
    assert.deepEqual(completion, {
      kind: "authentication_failure",
      safeCode: "openai_responses_key_not_configured",
    });
    assert.equal(calls.length, 0);
  });

  it("puts trusted rules in instructions, not in the input array", () => {
    const body = buildResponsesRequestBody({ ...BASE, instructions: "rules" }, [
      { kind: "user", text: "go" },
    ]);
    assert.equal(body["instructions"], "rules");
    const input = body["input"] as readonly Record<string, unknown>[];
    assert.equal(input.length, 1);
    assert.equal(input[0]?.["type"], "message");
  });

  it("renders a user turn as a message with input_text", () => {
    const body = buildResponsesRequestBody(BASE, [{ kind: "user", text: "go" }]);
    const input = body["input"] as readonly Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "go" }],
    });
  });

  it("renders a function call as its own item with string arguments", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "assistant",
        text: null,
        toolCalls: [
          { providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } },
        ],
      },
    ];
    const body = buildResponsesRequestBody(BASE, conversation);
    const input = body["input"] as readonly Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "function_call",
      call_id: "c1",
      name: "read_file",
      arguments: JSON.stringify({ path: "a.ts" }),
    });
  });

  it("renders a tool result as function_call_output", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "read_file",
        status: "succeeded",
        text: "body",
      },
    ];
    const body = buildResponsesRequestBody(BASE, conversation);
    const input = body["input"] as readonly Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "function_call_output",
      call_id: "c1",
      output: "body",
    });
  });

  it("marks a failed tool result in the output text", () => {
    const conversation: readonly ProviderConversationItem[] = [
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "shell",
        status: "outcome_unknown",
        text: null,
      },
    ];
    const body = buildResponsesRequestBody(BASE, conversation);
    const input = body["input"] as readonly Record<string, unknown>[];
    assert.match(String(input[0]?.["output"]), /outcome_unknown/);
  });

  it("flattens tool definitions to the flat function shape", () => {
    const body = buildResponsesRequestBody(
      {
        ...BASE,
        tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      },
      [{ kind: "user", text: "go" }],
    );
    assert.deepEqual(body["tools"], [
      {
        type: "function",
        name: "read_file",
        description: "Read",
        parameters: { type: "object" },
      },
    ]);
  });

  it("adds the built-in web search tool before function tools", () => {
    const body = buildResponsesRequestBody(
      {
        ...BASE,
        nativeWebSearch: true,
        tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      },
      [{ kind: "user", text: "go" }],
    );
    assert.deepEqual(body["tools"], [
      { type: "web_search" },
      {
        type: "function",
        name: "read_file",
        description: "Read",
        parameters: { type: "object" },
      },
    ]);
  });
});

describe("openai responses interpretation", () => {
  it("extracts message text", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
      }),
    );
    assert.deepEqual(completion, { kind: "completed", toolCalls: [], text: "hello" });
  });

  it("extracts a function call and its arguments", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "read_file",
            arguments: '{"path":"a.ts"}',
          },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.deepEqual(completion.toolCalls, [
      { providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } },
    ]);
  });

  it("treats empty arguments as no arguments", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name: "todo", arguments: "" }],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.deepEqual(completion.toolCalls[0]?.arguments, {});
  });

  it("rejects malformed arguments", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name: "x", arguments: "{bad" }],
      }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_responses_arguments_not_json",
    });
  });

  it("rejects an incomplete response so its calls cannot execute", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "incomplete",
        output: [{ type: "function_call", call_id: "c1", name: "x", arguments: "{}" }],
      }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_responses_incomplete",
    });
  });

  it("rejects a failed response", () => {
    const completion = interpretResponsesResponse(JSON.stringify({ status: "failed", output: [] }));
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_responses_failed",
    });
  });

  it("ignores reasoning items", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.equal(completion.text, "answer");
    assert.deepEqual(completion.toolCalls, []);
  });

  it("ignores a provider-run web search call", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "web_search_call", id: "ws1", status: "completed" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer from search" }],
          },
        ],
      }),
    );
    assert.equal(completion.kind, "completed");
    if (completion.kind !== "completed") return;
    assert.equal(completion.text, "answer from search");
    assert.deepEqual(completion.toolCalls, []);
  });

  it("rejects a failed provider-run web search", () => {
    assert.deepEqual(
      interpretResponsesResponse(
        JSON.stringify({
          status: "completed",
          output: [{ type: "web_search_call", id: "ws1", status: "failed" }],
        }),
      ),
      {
        kind: "invalid_response",
        safeCode: "openai_responses_web_search_failed",
      },
    );
  });

  it("rejects a refusal rather than presenting it as assistant content", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "cannot help" }],
          },
        ],
      }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_responses_refusal",
    });
  });

  it("rejects an unknown item type", () => {
    const completion = interpretResponsesResponse(
      JSON.stringify({ status: "completed", output: [{ type: "mystery" }] }),
    );
    assert.deepEqual(completion, {
      kind: "invalid_response",
      safeCode: "openai_responses_item_unknown",
    });
  });

  it("rejects a missing output array", () => {
    assert.deepEqual(interpretResponsesResponse(JSON.stringify({ status: "completed" })), {
      kind: "invalid_response",
      safeCode: "openai_responses_output_missing",
    });
  });

  it("rejects a non-JSON body", () => {
    assert.deepEqual(interpretResponsesResponse("<html>"), {
      kind: "invalid_response",
      safeCode: "openai_responses_body_not_json",
    });
  });

  it("rejects an error payload", () => {
    assert.deepEqual(interpretResponsesResponse(JSON.stringify({ error: {} })), {
      kind: "invalid_response",
      safeCode: "openai_responses_error_payload",
    });
  });
});

describe("openai responses status mapping", () => {
  async function outcome(status: number, headers: Record<string, string> = {}) {
    const { post } = capture(jsonResponse(status, {}, headers));
    return provider(post).complete(REQUEST);
  }

  it("maps 401 to authentication failure", async () => {
    assert.deepEqual(await outcome(401), {
      kind: "authentication_failure",
      safeCode: "openai_responses_unauthorized",
    });
  });

  it("maps 429 to a transient failure with Retry-After", async () => {
    const result = await outcome(429, { "retry-after": "4" });
    assert.equal(result.kind, "transient_failure");
    if (result.kind !== "transient_failure") return;
    assert.equal(result.retryAfterMs, 4000);
  });

  it("maps 5xx to a transient failure", async () => {
    assert.equal((await outcome(502)).kind, "transient_failure");
  });

  it("maps a redirect to an invalid response", async () => {
    assert.deepEqual(await outcome(307), {
      kind: "invalid_response",
      safeCode: "openai_responses_unexpected_redirect",
    });
  });

  it("maps other 4xx to an invalid response", async () => {
    assert.deepEqual(await outcome(422), {
      kind: "invalid_response",
      safeCode: "openai_responses_request_rejected",
    });
  });
});
