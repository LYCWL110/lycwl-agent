import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { after, before, describe, it } from "node:test";

import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";

let server: Server | null = null;
let port = 0;
let certPem = "";
const bodies: Record<string, unknown>[] = [];

before(async () => {
  const { TEST_CERT_PEM, TEST_KEY_PEM } = await import("../fakes/web-cert.ts");
  certPem = TEST_CERT_PEM;
  await new Promise<void>((resolve) => {
    server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
        setTimeout(() => {
          response.write(
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
          );
          response.end("data: [DONE]\n\n");
        }, 5);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address !== null && typeof address === "object") port = address.port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("provider streaming over HTTPS", () => {
  it("parses a real SSE response through the bounded transport", async () => {
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "test-key",
      model: "chat-test",
      baseUrl: `https://localhost:${port}`,
      trustedCaPem: certPem,
    });
    const deltas: string[] = [];
    const completion = await provider.stream(
      {
        modelRequestId: "stream-1",
        attemptNo: 1,
        conversation: [{ kind: "user", text: "hello" }],
      },
      (delta) => deltas.push(delta.text),
    );

    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.deepEqual(completion, {
      kind: "completed",
      toolCalls: [],
      text: "hello",
    });
    assert.equal(bodies[0]?.["stream"], true);
  });
});
