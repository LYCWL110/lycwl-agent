import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

let server: Server | null = null;
let port = 0;
let certPem = "";
let workspaceRoot = "";
const bodies: Record<string, unknown>[] = [];
let round = 0;

before(async () => {
  const { TEST_CERT_PEM, TEST_KEY_PEM } = await import("../fakes/web-cert.ts");
  certPem = TEST_CERT_PEM;
  await new Promise<void>((resolve) => {
    server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        round += 1;

        if (round === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "read_file",
                  input: { path: "src/api/handler.ts" },
                },
              ],
            }),
          );
          return;
        }

        if (round === 2) {
          // Remove the rule between the first and second touch of the directory.
          void unlink(path.join(workspaceRoot, "src/api/AGENTS.md"))
            .then(() => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  content: [
                    {
                      type: "tool_use",
                      id: "tool-2",
                      name: "read_file",
                      input: { path: "src/api/handler.ts" },
                    },
                  ],
                }),
              );
            })
            .catch(() => {
              response.writeHead(500);
              response.end();
            });
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "done" }] }));
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

describe("guidance removal", () => {
  function messageText(message: Record<string, unknown>): string {
    const content = message["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) =>
          typeof block === "object" && block !== null
            ? String((block as Record<string, unknown>)["text"] ?? "")
            : String(block),
        )
        .join("\n");
    }
    return "";
  }

  it("appends a removed block when an injected AGENTS.md disappears", async () => {
    bodies.length = 0;
    round = 0;
    const workspace = await mkdtemp(path.join(tmpdir(), "lycwl-remove-ws-"));
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-remove-data-"));
    workspaceRoot = workspace;
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "root rule\n", "utf8");
      await mkdir(path.join(workspace, "src", "api"), { recursive: true });
      await writeFile(path.join(workspace, "src", "api", "AGENTS.md"), "api rule\n", "utf8");
      await writeFile(
        path.join(workspace, "src", "api", "handler.ts"),
        "export const x = 1;\n",
        "utf8",
      );

      const store = createConfigStore({ directory: data });
      const vault = createFileVault({ directory: data });
      const saved = await saveSetup({
        draft: {
          baseUrl: `https://localhost:${port}`,
          model: "claude-local-test",
          contextWindow: 128000,
          credentialRef: "provider-main",
          apiKey: "local-test-key",
        },
        vault,
        store,
      });
      assert.equal(saved.ok, true, saved.ok ? "" : saved.code);

      const loaded = await store.load();
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      const parsed = parseJsonc(loaded.value.text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const selection = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings: toPlainValue(parsed.value),
        hasSettings: true,
        trustedCaPem: certPem,
      });
      assert.equal(selection.kind, "real", selection.kind === "demo" ? selection.reason : "");
      if (selection.kind !== "real") return;

      const result = await selection.coordinator.run("look at the handler");
      assert.equal(result.status, "completed");
      assert.equal(bodies.length, 3);

      const firstMessages = bodies[0]?.["messages"] as readonly Record<string, unknown>[];
      const secondMessages = bodies[1]?.["messages"] as readonly Record<string, unknown>[];
      const thirdMessages = bodies[2]?.["messages"] as readonly Record<string, unknown>[];
      assert.deepEqual(secondMessages[0], firstMessages[0]);
      assert.deepEqual(thirdMessages[0], firstMessages[0]);

      const secondText = secondMessages.map(messageText).join("\n");
      assert.match(secondText, /api rule/);
      assert.match(secondText, /\(new,/);

      const thirdText = thirdMessages.map(messageText).join("\n");
      assert.match(thirdText, /\(removed;/);
      assert.match(thirdText, /earlier guidance from this path is withdrawn/);
      assert.match(thirdText, /src\/api\/AGENTS\.md/);
      // The earlier block remains, but the removal names the path as withdrawn.
      assert.match(thirdText, /api rule/);
      assert.equal((thirdText.match(/root rule/gu) ?? []).length, 1);
    } finally {
      await closeRuntimeSelections();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
