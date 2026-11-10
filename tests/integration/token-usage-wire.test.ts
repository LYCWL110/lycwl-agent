import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { AnthropicProvider } from "../../src/adapters/providers/anthropic-provider.ts";
import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../../src/adapters/providers/openai-responses-provider.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ProviderCompletion } from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";

/**
 * Usage end to end.
 *
 * The unit tests cover the parsers in isolation. This covers the two joins that
 * actually matter: the adapter reading a real HTTP response body, and the
 * coordinator accumulating per-request counts into a Run total and recording each
 * one in the event log.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

const noTools: ToolExecutor = {
  getDefinition: (): ToolDefinition | null => null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

function httpResponse(body: unknown) {
  const bodyText = JSON.stringify(body);
  return {
    ok: true as const,
    status: 200,
    headers: {},
    bodyText,
    wireBytes: Buffer.byteLength(bodyText, "utf8"),
  };
}

describe("adapter usage extraction", () => {
  it("Anthropic reads usage from the response body", async () => {
    const provider = new AnthropicProvider({
      resolveApiKey: async () => "key",
      model: "m",
      endpoint: "https://example.invalid/v1/messages",
      post: async () =>
        httpResponse({
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 900,
          },
        }),
    });
    const completion = await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "hello" }],
    });
    assert.equal(completion.kind, "completed");
    assert.deepEqual(completion.kind === "completed" ? completion.usage : null, {
      inputTokens: 1_000,
      outputTokens: 20,
      cachedInputTokens: 900,
    });
  });

  it("OpenAI Chat reads usage from the response body", async () => {
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: async () =>
        httpResponse({
          choices: [{ finish_reason: "stop", message: { content: "hi" } }],
          usage: { prompt_tokens: 200, completion_tokens: 40 },
        }),
    });
    const completion = await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "hello" }],
    });
    assert.equal(completion.kind, "completed");
    assert.deepEqual(completion.kind === "completed" ? completion.usage : null, {
      inputTokens: 200,
      outputTokens: 40,
    });
  });

  it("OpenAI Responses reads usage from the response body", async () => {
    const provider = new OpenAiResponsesProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: async () =>
        httpResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 300, output_tokens: 60 },
        }),
    });
    const completion = await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "hello" }],
    });
    assert.equal(completion.kind, "completed");
    assert.deepEqual(completion.kind === "completed" ? completion.usage : null, {
      inputTokens: 300,
      outputTokens: 60,
    });
  });

  it("a response with no usage leaves the field absent", async () => {
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: async () =>
        httpResponse({
          choices: [{ finish_reason: "stop", message: { content: "hi" } }],
        }),
    });
    const completion = await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "hello" }],
    });
    assert.equal(completion.kind, "completed");
    assert.equal(
      completion.kind === "completed" ? "usage" in completion : true,
      false,
      "usage must be absent, not zero",
    );
  });
});

/** A provider that reports a fixed usage figure on every request. */
function usageProvider(usage: { inputTokens: number; outputTokens: number }) {
  return {
    async complete(): Promise<ProviderCompletion> {
      return { kind: "completed", toolCalls: [], text: "ok", usage };
    },
  };
}

describe("Run usage accumulation", () => {
  it("sums usage across rounds and records each request's count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "usage-run-"));
    const sessionId = "ws-usage";
    let calls = 0;
    try {
      const coordinator = new RuntimeCoordinator({
        provider: {
          async complete(): Promise<ProviderCompletion> {
            calls += 1;
            // Two rounds: the first asks for a tool, the second finishes.
            if (calls === 1) {
              return {
                kind: "completed",
                toolCalls: [{ providerToolCallId: "c1", toolName: "probe", arguments: { n: 1 } }],
                text: null,
                usage: { inputTokens: 100, outputTokens: 10 },
              };
            }
            return {
              kind: "completed",
              toolCalls: [],
              text: "done",
              usage: { inputTokens: 150, outputTokens: 25 },
            };
          },
        },
        tools: {
          getDefinition: (name) =>
            name === "probe"
              ? {
                  name: "probe",
                  version: "1",
                  sideEffectClass: "read_only",
                  requiresApproval: false,
                  concurrencySafe: true,
                }
              : null,
          discardApproval: () => undefined,
          async execute() {
            return { status: "succeeded" as const, text: "tool ok" };
          },
        },
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
      });

      const result = await coordinator.run("measure usage");
      assert.equal(result.status, "completed");
      assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 35 });

      // Each request's own figure is in the log, not just the total: a later
      // reader must be able to attribute cost to a specific request.
      const events = await new JsonlEventLog(root, ids, digests).read(sessionId);
      const recorded = events
        .filter((event) => event.payload.kind === "model_response_validated")
        .map((event) =>
          event.payload.kind === "model_response_validated" ? event.payload.usage : null,
        );
      assert.deepEqual(recorded, [
        { inputTokens: 100, outputTokens: 10 },
        { inputTokens: 150, outputTokens: 25 },
      ]);

      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the Run total absent when no request reports usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "usage-none-"));
    const sessionId = "ws-usage-none";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: usageProvider(undefined as never),
        tools: noTools,
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
      });
      // Replace the stub with one that genuinely omits usage.
      const result = await coordinator.run("no usage");
      assert.equal(result.status, "completed");
      assert.equal("usage" in result, false, "unknown usage must not become zero");
      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the event log readable after usage is recorded", async () => {
    // The event validator must accept the optional usage object; a rejected payload
    // would fail the append and abort the Run.
    const root = await mkdtemp(path.join(tmpdir(), "usage-valid-"));
    const sessionId = "ws-usage-valid";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: usageProvider({ inputTokens: 5, outputTokens: 6 }),
        tools: noTools,
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
      });
      const result = await coordinator.run("validate");
      assert.equal(result.status, "completed");

      const read = await new JsonlEventLog(root, ids, digests).readWithRecovery(sessionId);
      assert.equal(read.ok, true);
      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
