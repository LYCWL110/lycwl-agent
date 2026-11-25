import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { availableTools, TOOL_CATALOG } from "../../src/domain/tool-catalog/tool-catalog.ts";
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

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
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
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

describe("tool catalog", () => {
  it("lists the tools implemented in this build", () => {
    const names = TOOL_CATALOG.map((entry) => entry.name).sort();
    assert.deepEqual(names, [
      "apply_patch",
      "ask_user",
      "background_output",
      "background_start",
      "background_status",
      "background_stop",
      "create_file",
      "delete_path",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "lsp_definition",
      "lsp_diagnostics",
      "lsp_references",
      "read_file",
      "rename_path",
      "shell",
      "skill",
      "todo",
      "web_fetch",
      "web_search",
    ]);
  });

  it("gives every entry a non-empty description and a closed schema", () => {
    for (const entry of TOOL_CATALOG) {
      assert.ok(entry.description.length > 20, `${entry.name} needs a real description`);
      assert.equal(entry.inputSchema.type, "object");
      assert.equal(
        entry.inputSchema.additionalProperties,
        false,
        `${entry.name} must reject unknown properties`,
      );
      for (const required of entry.inputSchema.required) {
        assert.ok(
          required in entry.inputSchema.properties,
          `${entry.name} requires ${required} but does not declare it`,
        );
      }
    }
  });

  it("does not advertise a tool that is unavailable", () => {
    const filtered = availableTools((name) => name !== "read_file");
    assert.equal(
      filtered.some((entry) => entry.name === "read_file"),
      false,
    );
  });

  it("keeps catalog order stable", () => {
    assert.deepEqual(
      TOOL_CATALOG.map((entry) => entry.name),
      [
        "read_file",
        "list_dir",
        "glob",
        "grep",
        "lsp_diagnostics",
        "lsp_definition",
        "lsp_references",
        "web_search",
        "web_fetch",
        "todo",
        "create_file",
        "edit_file",
        "apply_patch",
        "delete_path",
        "rename_path",
        "ask_user",
        "shell",
        "background_start",
        "background_status",
        "background_output",
        "background_stop",
        "skill",
      ],
    );
  });
});

describe("tool schemas reach the wire", () => {
  it("sends the available tool definitions to the provider", async () => {
    bodies.length = 0;
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl-tools-"));
    try {
      const store = createConfigStore({ directory });
      const vault = createFileVault({ directory });

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

      const { parseJsonc, toPlainValue } = await import("../../src/domain/config/jsonc.ts");
      const parsed = parseJsonc(loaded.value.text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const settings = toPlainValue(parsed.value);

      const selection = await selectRuntime({
        workspaceRoot: directory,
        dataDirectory: directory,
        settings,
        hasSettings: true,
        // Trust the local self-signed fixture certificate.
        trustedCaPem: certPem,
      });

      // The selection must be real, not a demo fallback.
      assert.equal(selection.kind, "real", selection.kind === "demo" ? selection.reason : "");

      const result = await selection.coordinator.run("hello");
      assert.equal(result.status, "completed");

      assert.equal(bodies.length, 1);
      const body = bodies[0];
      assert.ok(body);
      const tools = body["tools"] as readonly Record<string, unknown>[] | undefined;
      assert.ok(Array.isArray(tools), "the request must carry tool definitions");

      // Writes are off by default, so the mutating tools must not be advertised.
      const names = tools?.map((tool) => tool["name"]).sort();
      assert.deepEqual(names, [
        "ask_user",
        "glob",
        "grep",
        "list_dir",
        "read_file",
        "todo",
        "web_fetch",
        "web_search",
      ]);
      assert.equal(
        names?.includes("create_file"),
        false,
        "a write tool must not appear when writes are disabled",
      );
      for (const tool of tools ?? []) {
        assert.equal(typeof tool["description"], "string");
        assert.equal((tool["input_schema"] as { type?: string }).type, "object");
      }
    } finally {
      await closeRuntimeSelections();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("advertises the write tools when writes are enabled", async () => {
    bodies.length = 0;
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl-tools-write-"));
    try {
      const store = createConfigStore({ directory });
      const vault = createFileVault({ directory });
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
      const { parseJsonc, toPlainValue } = await import("../../src/domain/config/jsonc.ts");
      const parsed = parseJsonc(loaded.value.text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const selection = await selectRuntime({
        workspaceRoot: directory,
        dataDirectory: directory,
        settings: toPlainValue(parsed.value),
        hasSettings: true,
        enableWrites: true,
        trustedCaPem: certPem,
      });
      assert.equal(selection.kind, "real", selection.kind === "demo" ? selection.reason : "");
      if (selection.kind !== "real") return;
      assert.equal(selection.enableWrites, true);

      await selection.coordinator.run("hello");

      const tools = bodies[0]?.["tools"] as readonly Record<string, unknown>[] | undefined;
      const names = tools?.map((tool) => tool["name"]).sort();
      assert.deepEqual(names, [
        "apply_patch",
        "ask_user",
        "create_file",
        "delete_path",
        "edit_file",
        "glob",
        "grep",
        "list_dir",
        "read_file",
        "rename_path",
        "todo",
        "web_fetch",
        "web_search",
      ]);
    } finally {
      await closeRuntimeSelections();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
