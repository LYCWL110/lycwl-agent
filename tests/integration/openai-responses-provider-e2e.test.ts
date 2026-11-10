import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { after, before, describe, it } from "node:test";

import { OpenAiResponsesProvider } from "../../src/adapters/providers/openai-responses-provider.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * End-to-end: the real Responses adapter, the real bounded HTTPS transport and the
 * real coordinator against a local self-signed server.
 *
 * Proves the Responses-specific shape on the wire: a typed `input` array, a
 * `function_call` item with string arguments, and a `function_call_output` item.
 *
 * It does not prove anything about a real vendor. G01 and G07 remain open.
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
          response.end(
            JSON.stringify({
              status: "completed",
              output: [
                { type: "reasoning", summary: [] },
                {
                  type: "function_call",
                  call_id: "call-1",
                  name: "read_note",
                  arguments: '{"path":"a.ts"}',
                },
              ],
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "all done" }],
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

describe("openai responses provider end to end", () => {
  it("completes a tool round trip over real TLS", async () => {
    received.length = 0;
    round = 0;
    const tools = new OneTool();
    const provider = new OpenAiResponsesProvider({
      resolveApiKey: async () => "local-test-key",
      model: "gpt-local-test",
      baseUrl: `https://localhost:${port}`,
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
    assert.equal(received.length, 2);

    const first = received[0];
    assert.ok(first);
    assert.equal(first.headers["authorization"], "Bearer local-test-key");
    assert.equal(JSON.stringify(first.body).includes("local-test-key"), false);

    const firstInput = first.body["input"] as readonly Record<string, unknown>[];
    assert.deepEqual(firstInput[0], {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "read a.ts for me" }],
    });

    // The follow-up must contain the call item and its output item, keyed by the
    // same call id.
    const second = received[1];
    assert.ok(second);
    const input = second.body["input"] as readonly Record<string, unknown>[];
    const types = input.map((item) => item["type"]);
    assert.deepEqual(types, ["message", "function_call", "function_call_output"]);

    const call = input[1];
    assert.ok(call);
    assert.equal(call["call_id"], "call-1");
    assert.equal(call["name"], "read_note");
    assert.equal(typeof call["arguments"], "string");
    assert.deepEqual(JSON.parse(String(call["arguments"])), { path: "a.ts" });

    const output = input[2];
    assert.ok(output);
    assert.equal(output["call_id"], "call-1");
    assert.equal(output["output"], "note body");
  });

  it("fails closed before the socket when no credential resolves", async () => {
    received.length = 0;
    round = 0;
    const provider = new OpenAiResponsesProvider({
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
      safeCode: "openai_responses_key_not_configured",
    });
    assert.equal(received.length, 0);
  });
});
