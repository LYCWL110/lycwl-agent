import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { after, before, describe, it } from "node:test";
import { AnthropicProvider } from "../../src/adapters/providers/anthropic-provider.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * End-to-end: the real adapter, the real bounded HTTPS transport, and the real
 * coordinator against a local self-signed server.
 *
 * This proves the request reaches a socket with a valid TLS handshake, that the
 * credential travels in a header, that the assistant turn is present in the
 * follow-up request, and that a tool round trip completes.
 *
 * It does not prove anything about a real vendor, and makes no claim about
 * compatibility, price or result quality. G01 and G07 remain open.
 */

let server: Server | null = null;
let port = 0;
let certPem = "";
const received: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];

before(async () => {
  const { TEST_CERT_PEM, TEST_KEY_PEM } = await import("../fakes/web-cert.ts");
  certPem = TEST_CERT_PEM;
  let round = 0;
  await new Promise<void>((resolve) => {
    server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        received.push({
          body,
          headers: request.headers as Record<string, string>,
        });
        round += 1;

        response.writeHead(200, { "content-type": "application/json" });
        if (round === 1) {
          // First turn: ask for a tool.
          response.end(
            JSON.stringify({
              content: [
                { type: "text", text: "let me read it" },
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "read_note",
                  input: { path: "a.ts" },
                },
              ],
            }),
          );
          return;
        }
        response.end(JSON.stringify({ content: [{ type: "text", text: "all done" }] }));
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

  async execute(request: { toolName: string; arguments: unknown }) {
    this.executions.push(request.toolName);
    return { status: "succeeded" as const, text: "note body" };
  }
}

describe("anthropic provider end to end", () => {
  it("completes a tool round trip over real TLS", async () => {
    received.length = 0;
    const tools = new OneTool();
    const provider = new AnthropicProvider({
      resolveApiKey: async () => "local-test-key",
      model: "claude-local-test",
      endpoint: `https://localhost:${port}/v1/messages`,
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

    assert.equal(result.status, "completed");
    assert.equal(result.text, "all done");
    assert.deepEqual(tools.executions, ["read_note"]);

    // Two real HTTPS requests reached the server.
    assert.equal(received.length, 2);

    const first = received[0];
    assert.ok(first);
    // The credential is a header and never in the body.
    assert.equal(first.headers["x-api-key"], "local-test-key");
    assert.equal(JSON.stringify(first.body).includes("local-test-key"), false);
    assert.equal(first.headers["anthropic-version"], "2023-06-01");

    // The follow-up carries the assistant turn with its tool_use block, then the
    // tool result. Without the assistant turn this history would be invalid.
    const second = received[1];
    assert.ok(second);
    const messages = second.body["messages"] as readonly Record<string, unknown>[];
    const roles = messages.map((entry) => entry["role"]);
    assert.deepEqual(roles, ["user", "assistant", "user"]);

    const assistant = messages[1];
    assert.ok(assistant);
    const content = assistant["content"] as readonly Record<string, unknown>[];
    assert.equal(content[0]?.["type"], "text");
    assert.equal(content[1]?.["type"], "tool_use");
    assert.equal(content[1]?.["id"], "tool-1");

    const toolResult = messages[2];
    assert.ok(toolResult);
    const blocks = toolResult["content"] as readonly Record<string, unknown>[];
    assert.equal(blocks[0]?.["type"], "tool_result");
    assert.equal(blocks[0]?.["tool_use_id"], "tool-1");
    assert.equal(blocks[0]?.["content"], "note body");
  });
});
