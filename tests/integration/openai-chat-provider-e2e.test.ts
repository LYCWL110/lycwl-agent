import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { after, before, describe, it } from "node:test";

import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * End-to-end: the real Chat Completions adapter, the real bounded HTTPS transport
 * and the real coordinator against a local self-signed server.
 *
 * ADR-0051 recorded that this adapter was contract-tested only, while the Anthropic
 * adapter had a real socket round trip. This closes that gap for the chat-specific
 * request and response path.
 *
 * It does not prove anything about a real vendor, and makes no claim about
 * compatibility, price or result quality. G01 and G07 remain open.
 */

let server: Server | null = null;
let port = 0;
let certPem = "";
const received: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
let round = 0;

before(async () => {
  const { TEST_CERT_PEM, TEST_KEY_PEM } = await import("../fakes/web-cert.ts");
  certPem = TEST_CERT_PEM;
  await new Promise<void>((resolve) => {
    server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          headers: request.headers as Record<string, string>,
        });
        round += 1;

        response.writeHead(200, { "content-type": "application/json" });
        if (round === 1) {
          // First turn: request a tool. Arguments are a JSON string, as the chat
          // protocol requires.
          response.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: "let me read it",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "read_note", arguments: '{"path":"a.ts"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "all done" },
              },
            ],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  if (server !== null) await new Promise<void>((resolve) => server?.close(() => resolve()));
});

class OneTool implements ToolExecutor {
  readonly executions: string[] = [];
  readonly #definition: ToolDefinition = {
    name: "read_note",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
  };

  getDefinition(toolName: string): ToolDefinition | null {
    return toolName === this.#definition.name ? this.#definition : null;
  }

  async execute(request: { toolName: string }) {
    this.executions.push(request.toolName);
    return { status: "succeeded" as const, text: "note body" };
  }
}

describe("openai chat provider end to end", () => {
  it("completes a tool round trip over real TLS", async () => {
    received.length = 0;
    round = 0;
    const tools = new OneTool();
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "local-test-key",
      model: "gpt-local-test",
      baseUrl: `https://localhost:${port}`,
      // Trust the local self-signed fixture certificate. Production leaves this
      // undefined and relies on the system trust store.
      trustedCaPem: certPem,
    });

    const coordinator = new RuntimeCoordinator({
      provider,
      tools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
      ids: new SequenceIds(),
      nowUtc: () => "2026-11-05T00:00:00.000Z",
      suspendOnApproval: false,
    });

    const result = await coordinator.run("read a.ts for me");

    assert.equal(result.status, "completed", result.safeCode ?? "");
    assert.equal(result.text, "all done");
    assert.deepEqual(tools.executions, ["read_note"]);

    // Two real HTTPS requests reached the server.
    assert.equal(received.length, 2);

    const first = received[0];
    assert.ok(first);
    // The credential is a bearer header and never in the body.
    assert.equal(first.headers["authorization"], "Bearer local-test-key");
    assert.equal(JSON.stringify(first.body).includes("local-test-key"), false);
    assert.equal(first.body["model"], "gpt-local-test");

    const firstMessages = first.body["messages"] as readonly Record<string, unknown>[];
    assert.equal(firstMessages[0]?.["role"], "user");
    assert.equal(firstMessages[0]?.["content"], "read a.ts for me");

    // The follow-up carries assistant tool_calls with a JSON-string argument, then
    // a role-tool message keyed by the call id.
    const second = received[1];
    assert.ok(second);
    const messages = second.body["messages"] as readonly Record<string, unknown>[];
    const roles = messages.map((entry) => entry["role"]);
    assert.deepEqual(roles, ["user", "assistant", "tool"]);

    const assistant = messages[1];
    assert.ok(assistant);
    const toolCalls = assistant["tool_calls"] as readonly Record<string, unknown>[];
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.["id"], "call-1");
    const fn = toolCalls[0]?.["function"] as Record<string, unknown>;
    assert.equal(fn["name"], "read_note");
    assert.equal(typeof fn["arguments"], "string");
    assert.deepEqual(JSON.parse(String(fn["arguments"])), { path: "a.ts" });

    const toolMessage = messages[2];
    assert.ok(toolMessage);
    assert.equal(toolMessage["tool_call_id"], "call-1");
    assert.equal(toolMessage["content"], "note body");
  });

  it("fails closed before the socket when no credential resolves", async () => {
    received.length = 0;
    round = 0;
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => null,
      model: "gpt-local-test",
      baseUrl: `https://localhost:${port}`,
      trustedCaPem: certPem,
    });

    const completion = await provider.complete({
      modelRequestId: "r1",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "hi" }],
    });

    assert.deepEqual(completion, {
      kind: "authentication_failure",
      safeCode: "openai_chat_key_not_configured",
    });
    // Nothing reached the socket.
    assert.equal(received.length, 0);
  });
});
