import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import { canResumeSession } from "../../src/bootstrap/session-launch.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import { createTuiController } from "../../src/tui/controller.ts";

describe("session command persistence", () => {
  it("rebuilds only the explicitly selected context and visible transcript, without replaying operations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-session-commands-"));
    try {
      const store = createConfigStore({ directory: root });
      const vault = createFileVault({ directory: root });
      assert.ok(
        (
          await saveSetup({
            store,
            vault,
            draft: {
              protocol: "openai_chat",
              baseUrl: "https://fixture.example/v1",
              model: "fixture-model",
              contextWindow: 128000,
              credentialRef: "fixture",
              apiKey: "synthetic-credential-never-use",
            },
          })
        ).ok,
      );
      const loaded = await store.load();
      assert.ok(loaded.ok);
      const parsed = parseJsonc(loaded.value.text);
      assert.ok(parsed.ok);
      const bodies: string[] = [];
      const open = async (sessionId: string) => {
        const runtime = await selectRuntime({
          workspaceRoot: root,
          dataDirectory: root,
          hasSettings: true,
          settings: toPlainValue(parsed.value),
          sessionId,
          post: async (request) => {
            bodies.push(request.bodyText);
            return {
              ok: true,
              status: 200,
              headers: {},
              wireBytes: 0,
              bodyText: JSON.stringify({ choices: [{ message: { content: "fixture reply" } }] }),
            };
          },
        });
        assert.equal(runtime.kind, "real");
        if (runtime.kind !== "real") throw new Error("fixture runtime");
        return createTuiController({
          coordinator: runtime.coordinator,
          initialEvents: runtime.historyEvents,
          canResumeSession: (id) => canResumeSession(root, id),
        });
      };
      const first = await open("first");
      await first.submit("remember a private number");
      assert.ok(await canResumeSession(root, "first"));
      await first.submit("/new");
      assert.deepEqual(first.takeNavigationRequest(), { kind: "session", sessionId: null });
      await first.close();
      const fresh = await open("fresh");
      assert.deepEqual(fresh.view().transcript, []);
      await fresh.submit("new context");
      assert.doesNotMatch(bodies[1] ?? "", /private number/);
      await fresh.submit("/session resume first");
      assert.deepEqual(fresh.takeNavigationRequest(), { kind: "session", sessionId: "first" });
      await fresh.close();
      const beforeResume = bodies.length;
      const resumed = await open("first");
      assert.equal(bodies.length, beforeResume, "opening history does not call a Provider");
      assert.equal(resumed.view().runStatus, "idle");
      assert.match(JSON.stringify(resumed.view().transcript), /private number/);
      assert.doesNotMatch(JSON.stringify(resumed.view().transcript), /new context/);
      await resumed.submit("what did we discuss");
      assert.match(bodies[2] ?? "", /private number/);
      assert.doesNotMatch(bodies[2] ?? "", /new context/);
      await resumed.close();
      const beforeRotation = await store.load();
      assert.ok(beforeRotation.ok);
      assert.ok(
        (
          await saveSetup({
            store,
            vault,
            baseDocument: beforeRotation.value,
            draft: {
              protocol: "openai_chat",
              baseUrl: "https://fixture.example/v1",
              model: "fixture-model",
              credentialRef: "fixture",
              apiKey: "private number",
            },
          })
        ).ok,
      );
      const blocked = await open("first");
      assert.deepEqual(
        blocked.view().transcript,
        [],
        "newly registered key matches block historical display",
      );
      const sent = bodies.length;
      await blocked.submit("continue");
      assert.equal(blocked.lastResult()?.safeCode, "protocol_history_incompatible");
      assert.equal(bodies.length, sent, "blocked historical payload is never sent");
      await blocked.close();
      assert.equal(await canResumeSession(root, "../first"), false);
      assert.equal(await canResumeSession(root, "missing"), false);
      const empty = path.join(root, "sessions", "sessions", "empty");
      await mkdir(empty);
      await writeFile(path.join(empty, "events.jsonl"), "");
      assert.equal(await canResumeSession(root, "empty"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
