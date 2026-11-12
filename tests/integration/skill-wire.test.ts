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
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

/**
 * The Skill catalog must reach the model as untrusted material, and only when the
 * Session enabled it.
 */

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

async function configured(data: string) {
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
  if (!loaded.ok) throw new Error("settings");
  const parsed = parseJsonc(loaded.value.text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("parse");
  return toPlainValue(parsed.value);
}

async function workspaceWithSkill(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lycwl-skills-wire-"));
  const target = path.join(directory, ".agents", "skills", "review");
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "SKILL.md"),
    "---\nname: review\ndescription: review code for null checks\n---\n\n# Review\n",
    "utf8",
  );
  return directory;
}

describe("skill catalog reaches the model", () => {
  it("includes the catalog when skills are enabled", async () => {
    bodies.length = 0;
    const workspace = await workspaceWithSkill();
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-skills-wire-data-"));
    try {
      const settings = await configured(data);
      const selection = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        enableSkills: true,
        trustedCaPem: certPem,
      });
      assert.equal(selection.kind, "real", selection.kind === "demo" ? selection.reason : "");
      if (selection.kind !== "real") return;

      assert.equal(selection.skills.kind, "loaded");
      if (selection.skills.kind === "loaded") {
        assert.equal(selection.skills.count, 1);
      }

      await selection.coordinator.run("review the code");

      const messages = bodies[0]?.["messages"] as readonly Record<string, unknown>[];
      const text = messages.map((message) => String(message["content"])).join("\n");
      assert.match(text, /project-skill-catalog/);
      assert.match(text, /review code for null checks/);
      assert.match(text, /untrusted project material/);
      // Never a system prompt. The system field carries the fixed Harness rules, so
      // the assertion is that the catalog is absent from it.
      const systemField = bodies[0]?.["system"];
      assert.equal(
        typeof systemField === "string" && systemField.includes("project-skill-catalog"),
        false,
      );
    } finally {
      await closeRuntimeSelections();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  it("omits the catalog when skills are disabled", async () => {
    bodies.length = 0;
    const workspace = await workspaceWithSkill();
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-skills-wire-off-"));
    try {
      const settings = await configured(data);
      const selection = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        trustedCaPem: certPem,
      });
      assert.equal(selection.kind, "real", selection.kind === "demo" ? selection.reason : "");
      if (selection.kind !== "real") return;

      assert.equal(selection.skills.kind, "disabled");

      await selection.coordinator.run("review the code");
      const messages = bodies[0]?.["messages"] as readonly Record<string, unknown>[];
      const text = messages.map((message) => String(message["content"])).join("\n");
      assert.equal(text.includes("project-skill-catalog"), false);
    } finally {
      await closeRuntimeSelections();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
