import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnthropicProvider } from "../../src/adapters/providers/anthropic-provider.ts";
import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../../src/adapters/providers/openai-responses-provider.ts";
import type { ProviderHttpRequest } from "../../src/adapters/providers/provider-http.ts";
import type { ModelProvider } from "../../src/ports/model-provider.ts";

describe("compaction wire mode", () => {
  for (const protocol of ["anthropic", "chat", "responses"] as const) {
    it(`omits tools and caps auxiliary output without changing main configuration: ${protocol}`, async () => {
      const bodies: Record<string, unknown>[] = [];
      const options = {
        model: "synthetic-model",
        baseUrl: "https://fixture.invalid",
        resolveApiKey: async () => "synthetic-auth",
        maxTokens: 4096,
        maxOutputTokens: 4096,
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
        post: async (request: ProviderHttpRequest) => {
          bodies.push(JSON.parse(request.bodyText));
          return { ok: true as const, status: 200, headers: {}, bodyText: "{}", wireBytes: 2 };
        },
      };
      const provider: ModelProvider =
        protocol === "chat"
          ? new OpenAiChatProvider(options)
          : protocol === "responses"
            ? new OpenAiResponsesProvider(options)
            : new AnthropicProvider(options);
      const request = {
        modelRequestId: "request",
        attemptNo: 1,
        conversation: [{ kind: "user" as const, text: "summarise" }],
      };
      await provider.complete({ ...request, compaction: { maxOutputTokens: 1200 } });
      await provider.complete(request);
      const field = protocol === "responses" ? "max_output_tokens" : "max_tokens";
      assert.equal(bodies[0]?.[field], 1200);
      assert.equal(bodies[0]?.["tools"], undefined);
      assert.equal(bodies[1]?.[field], 4096);
      assert.ok(Array.isArray(bodies[1]?.["tools"]));
    });
  }
});
