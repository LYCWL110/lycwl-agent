import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import { mergeTouchedPaths, touchedPaths } from "../../src/domain/context/touched-paths.ts";
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

let server: Server | null = null;
let port = 0;
let certPem = "";
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
        response.writeHead(200, { "content-type": "application/json" });
        if (round === 1) {
          // Ask to read a file inside a subdirectory that has its own AGENTS.md.
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

describe("touched path extraction", () => {
  it("reads the path parameter of known file tools", () => {
    assert.deepEqual(touchedPaths("read_file", { path: "a.ts" }), [
      { path: "a.ts", isDirectory: false },
    ]);
  });

  it("marks directory tools", () => {
    assert.deepEqual(touchedPaths("list_dir", { path: "src" }), [
      { path: "src", isDirectory: true },
    ]);
  });

  it("returns both sides of a rename", () => {
    assert.deepEqual(touchedPaths("rename_path", { from: "a", to: "b" }), [
      { path: "a", isDirectory: false },
      { path: "b", isDirectory: false },
    ]);
  });

  it("ignores an unknown tool", () => {
    assert.deepEqual(touchedPaths("mystery", { path: "a.ts" }), []);
  });

  it("ignores a missing or non-string path", () => {
    assert.deepEqual(touchedPaths("read_file", {}), []);
    assert.deepEqual(touchedPaths("read_file", { path: 42 }), []);
  });

  it("merges without duplicating", () => {
    const first = touchedPaths("read_file", { path: "a.ts" });
    const merged = mergeTouchedPaths(first, first);
    assert.equal(merged.length, 1);
  });
});

describe("subdirectory guidance reaches the model", () => {
  /** Flatten a message's content, whether it is a string or a block array. */
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

  it("injects the nested AGENTS.md after a tool touches that directory", async () => {
    bodies.length = 0;
    round = 0;
    const workspace = await mkdtemp(path.join(tmpdir(), "lycwl-scope-ws-"));
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-scope-data-"));
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "root rule\n", "utf8");
      await mkdir(path.join(workspace, "src", "api"), { recursive: true });
      await writeFile(
        path.join(workspace, "src", "api", "AGENTS.md"),
        "api rule: use UTC\n",
        "utf8",
      );
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

      // Two requests reached the server: the tool round trip.
      assert.equal(bodies.length, 2);

      // The first request carries only the root rule.
      const firstMessages = bodies[0]?.["messages"] as readonly Record<string, unknown>[];
      const firstText = firstMessages.map(messageText).join("\n");
      assert.match(firstText, /root rule/);
      assert.equal(firstText.includes("api rule"), false, "nested rule must not be loaded yet");

      // After touching src/api/handler.ts, the nested rule is injected as an update.
      const secondMessages = bodies[1]?.["messages"] as readonly Record<string, unknown>[];
      const secondText = secondMessages.map(messageText).join("\n");
      assert.match(secondText, /api rule: use UTC/, "nested guidance must be injected");

      // The launch block stays byte-identical so the cached prefix can be reused.
      assert.deepEqual(
        secondMessages[0],
        firstMessages[0],
        "launch guidance must stay byte-identical",
      );
      const rootGuidanceTurns = secondMessages.filter((m) =>
        messageText(m).includes("[project-guidance]"),
      );
      const updateTurns = secondMessages.filter((m) =>
        messageText(m).includes("[project-guidance-update]"),
      );
      assert.equal(rootGuidanceTurns.length, 1, "launch guidance must not be duplicated");
      assert.equal(updateTurns.length, 1, "new guidance must be one update turn");
      assert.match(messageText(updateTurns[0] ?? {}), /api rule: use UTC/);
      assert.equal((secondText.match(/root rule/gu) ?? []).length, 1);
      assert.match(messageText(secondMessages.at(-1) ?? {}), /\[project-guidance-update\]/);

      // A later Run re-injects guidance fresh; the update block is not history.
      const second = await selection.coordinator.run("continue");
      assert.equal(second.status, "completed");
      const thirdMessages = bodies[2]?.["messages"] as readonly Record<string, unknown>[];
      assert.notEqual(thirdMessages, undefined);
      const thirdText = thirdMessages.map(messageText).join("\n");
      assert.equal(
        thirdText.includes("api rule: use UTC"),
        false,
        "guidance updates must not be carried into a new Run",
      );
      assert.equal((thirdText.match(/root rule/gu) ?? []).length, 1);

      // It is still untrusted material, not a system prompt. The system field holds
      // the fixed Harness rules, so the assertion is that the guidance is absent.
      const systemField = bodies[1]?.["system"];
      assert.equal(
        typeof systemField === "string" && systemField.includes("api rule: use UTC"),
        false,
      );
    } finally {
      await closeRuntimeSelections();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
