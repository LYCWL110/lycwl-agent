import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import type { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import { selectSessionLaunch } from "../../src/bootstrap/session-launch.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";

/**
 * A resumed Session must continue with its history.
 *
 * ADR-0055 records that persistence kept the record but a restart did not rebuild
 * context. This drives two real launches against one data directory and asserts the
 * second request carries the first Run's conversation.
 */

let server: Server | null = null;
let port = 0;
let certPem = "";
const bodies: Record<string, unknown>[] = [];
const opened = new Set<RuntimeCoordinator>();
async function selectOwnedRuntime(options: Parameters<typeof selectRuntime>[0]) {
  const selected = await selectRuntime(options);
  if (selected.kind === "real") opened.add(selected.coordinator);
  return selected;
}
async function closeOpened() {
  for (const coordinator of opened) await coordinator.closeSession("test-close");
  opened.clear();
}

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
        response.end(JSON.stringify({ content: [{ type: "text", text: "acknowledged" }] }));
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

describe("session resume carries history", () => {
  it("isolates ordinary launches in the same workspace while keeping turns within a launch", async () => {
    bodies.length = 0;
    const workspace = await mkdtemp(path.join(tmpdir(), "lycwl-new-session-ws-"));
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-new-session-data-"));
    try {
      const settings = await configured(data);
      const firstLaunch = selectSessionLaunch([]);
      const nextLaunch = selectSessionLaunch([]);
      assert.ok(firstLaunch.ok && nextLaunch.ok);
      if (!firstLaunch.ok || !nextLaunch.ok) return;
      const first = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId: firstLaunch.sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(first.kind, "real");
      if (first.kind !== "real") return;
      await first.coordinator.run("private context from the previous launch");

      const next = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId: nextLaunch.sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(next.kind, "real");
      if (next.kind !== "real") return;
      assert.equal(next.prior.kind, "none");
      bodies.length = 0;
      await next.coordinator.run("start a new conversation");
      assert.doesNotMatch(JSON.stringify(bodies[0]), /private context from the previous launch/);
      await next.coordinator.run("continue this conversation");
      assert.match(JSON.stringify(bodies[1]), /start a new conversation/);
      assert.match(JSON.stringify(bodies[1]), /acknowledged/);
      assert.doesNotMatch(JSON.stringify(bodies[1]), /private context from the previous launch/);

      const resumed = selectSessionLaunch(["--resume", firstLaunch.sessionId]);
      assert.ok(resumed.ok);
      if (!resumed.ok) return;
      await first.coordinator.closeSession("handoff-first");
      const restored = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId: resumed.sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(restored.kind, "real");
      if (restored.kind !== "real") return;
      assert.equal(restored.prior.kind, "rebuilt");
      await restored.coordinator.run("resume only the first conversation");
      assert.match(JSON.stringify(bodies[2]), /private context from the previous launch/);
      assert.doesNotMatch(JSON.stringify(bodies[2]), /start a new conversation/);
    } finally {
      await closeOpened();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  it("prepends the previous run's conversation to the next launch", async () => {
    bodies.length = 0;
    const workspace = await mkdtemp(path.join(tmpdir(), "lycwl-resume-ws-"));
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-resume-data-"));
    try {
      const settings = await configured(data);
      const sessionId = "ws-resume-test";

      // First launch: one Run.
      const first = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(first.kind, "real", first.kind === "demo" ? first.reason : "");
      if (first.kind !== "real") return;
      assert.equal(first.prior.kind, "none", "the first launch has no history");

      const firstRun = await first.coordinator.run("remember the number seven");
      assert.equal(firstRun.status, "completed");
      assert.equal(bodies.length, 1);
      const busy = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(busy.kind, "demo");
      if (busy.kind === "demo") assert.equal(busy.reason, "session_busy");
      await first.coordinator.closeSession("handoff");

      // Second launch: a new coordinator over the same data directory.
      bodies.length = 0;
      const second = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId,
        trustedCaPem: certPem,
      });
      assert.equal(second.kind, "real", second.kind === "demo" ? second.reason : "");
      if (second.kind !== "real") return;

      assert.equal(second.prior.kind, "rebuilt", "history must be rebuilt");
      if (second.prior.kind === "rebuilt") {
        assert.equal(second.prior.runs, 1);
        assert.ok(second.prior.items >= 2, "user and assistant turns are present");
      }

      const secondRun = await second.coordinator.run("what number?");
      assert.equal(secondRun.status, "completed");

      // The request carries the earlier conversation before the new task.
      const messages = bodies[0]?.["messages"] as readonly Record<string, unknown>[];
      assert.ok(Array.isArray(messages));
      const text = messages
        .map((message) => (typeof message["content"] === "string" ? message["content"] : ""))
        .join("\n");
      assert.match(text, /remember the number seven/, "the earlier task must be present");
      assert.match(text, /what number\?/, "the new task must be present");

      // Ordering: earlier content precedes the new task.
      const firstUserIndex = messages.findIndex(
        (message) =>
          typeof message["content"] === "string" &&
          message["content"].includes("remember the number seven"),
      );
      const newTaskIndex = messages.findIndex(
        (message) =>
          typeof message["content"] === "string" && message["content"].includes("what number?"),
      );
      assert.ok(firstUserIndex >= 0 && newTaskIndex > firstUserIndex);
    } finally {
      await closeOpened();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  it("starts blank when the session id is different", async () => {
    bodies.length = 0;
    const workspace = await mkdtemp(path.join(tmpdir(), "lycwl-resume2-ws-"));
    const data = await mkdtemp(path.join(tmpdir(), "lycwl-resume2-data-"));
    try {
      const settings = await configured(data);

      const first = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId: "ws-one",
        trustedCaPem: certPem,
      });
      if (first.kind !== "real") return;
      await first.coordinator.run("task for session one");

      const other = await selectOwnedRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        settings,
        hasSettings: true,
        sessionId: "ws-two",
        trustedCaPem: certPem,
      });
      if (other.kind !== "real") return;
      assert.equal(other.prior.kind, "none");

      bodies.length = 0;
      await other.coordinator.run("task for session two");
      const text = JSON.stringify(bodies[0]?.["messages"] ?? []);
      assert.equal(text.includes("task for session one"), false);
    } finally {
      await closeOpened();
      await rm(workspace, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
