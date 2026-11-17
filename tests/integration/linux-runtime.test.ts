import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClipboardReader } from "../../src/adapters/linux/clipboard-image.ts";
import { createSnapshotStore } from "../../src/adapters/persistence/snapshot-store.ts";
import type { ProviderHttpRequest } from "../../src/adapters/providers/provider-http.ts";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { createGuidanceLoader } from "../../src/adapters/windows/guidance-loader.ts";
import { createSkillDiscovery } from "../../src/adapters/windows/skill-discovery.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { undoSessionChanges } from "../../src/bootstrap/undo.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";

describe("Linux runtime wiring", { skip: process.platform !== "linux" }, () => {
  it("loads nested guidance and skills using POSIX paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-guidance-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "AGENTS.md"), "root-rule\n");
      await writeFile(path.join(root, "src", "AGENTS.md"), "nested-rule\n");
      const loaded = await createGuidanceLoader({ workspaceRoot: root }).load({
        targetPath: "src/file.ts",
        targetIsDirectory: false,
      });
      assert.equal(loaded.ok, true);
      if (loaded.ok)
        assert.deepEqual(
          loaded.blocks.map((block) => block.text.trim()),
          ["root-rule", "nested-rule"],
        );
      const skillPath = path.join(root, ".agents", "skills", "example");
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, "SKILL.md"),
        "---\nname: example\ndescription: Example skill\n---\nUse this skill.\n",
      );
      const skills = await createSkillDiscovery({ workspaceRoot: root }).discover({
        enabled: true,
      });
      assert.equal(skills.ok, true);
      if (skills.ok) assert.equal(skills.catalog.skills.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs approved shell and observes background completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-tools-"));
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "linux-test" },
      enableProcesses: true,
      enableWrites: true,
    });
    try {
      const request = {
        toolCallId: "shell",
        toolName: "shell",
        arguments: { command: "printf linux-shell", cwd: "." },
      };
      assert.match((await tools.preview?.(request)) ?? "", /Linux.*permissions/);
      const shell = await tools.execute({ ...request, approvalGranted: true });
      assert.equal(shell.status, "succeeded");
      assert.match(shell.text ?? "", /linux-shell/);
      const background = await tools.execute({
        toolCallId: "bg",
        toolName: "background_start",
        arguments: { command: "printf background-ok", cwd: "." },
      });
      assert.equal(background.status, "succeeded");
      const taskId = /taskId=([^\n]+)/.exec(background.text ?? "")?.[1];
      assert.ok(taskId, background.text ?? "missing task id");
      let last = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        const status = await tools.execute({
          toolCallId: "status",
          toolName: "background_status",
          arguments: { taskId },
        });
        last = status.text ?? "";
        if (/state=exited/.test(last)) break;
        await delay(25);
      }
      assert.match(last, /state=exited/);
      assert.match(last, /exitCode=0/);
    } finally {
      await tools.cancelAll?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses separate config/state storage and resumes a persisted conversation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-session-"));
    const config = path.join(root, "config");
    const state = path.join(root, "state");
    const store = createConfigStore({ directory: config });
    const vault = createFileVault({ directory: config });
    let runtime: Awaited<ReturnType<typeof selectRuntime>> | undefined;
    try {
      const saved = await saveSetup({
        draft: {
          baseUrl: "https://localhost:443",
          model: "test-model",
          contextWindow: 128000,
          credentialRef: "provider-main",
          apiKey: "linux-fixture-key",
        },
        vault,
        store,
      });
      assert.equal(saved.ok, true);
      assert.equal((await stat(vault.filePath)).mode & 0o777, 0o600);
      const loaded = await store.load();
      assert.ok(loaded.ok);
      if (!loaded.ok) return;
      const parsed = parseJsonc(loaded.value.text);
      assert.ok(parsed.ok);
      if (!parsed.ok) return;
      const requests: ProviderHttpRequest[] = [];
      const options = {
        workspaceRoot: root,
        dataDirectory: config,
        stateDirectory: state,
        settings: toPlainValue(parsed.value),
        hasSettings: true,
        sessionId: "linux-session-test",
        post: async (request: ProviderHttpRequest) => {
          requests.push(request);
          const bodyText = JSON.stringify({
            content: [{ type: "text", text: "linux reply" }],
            stop_reason: "end_turn",
          });
          return {
            ok: true as const,
            status: 200,
            headers: {},
            bodyText,
            wireBytes: Buffer.byteLength(bodyText),
          };
        },
      };
      runtime = await selectRuntime(options);
      assert.equal(runtime.kind, "real");
      if (runtime.kind !== "real") return;
      const first = await runtime.coordinator.run("remember first Linux request");
      assert.equal(first.status, "completed");
      await runtime.coordinator.closeSession("close-first");
      runtime = await selectRuntime(options);
      assert.equal(runtime.kind, "real");
      if (runtime.kind !== "real") return;
      const second = await runtime.coordinator.run("second Linux request");
      assert.equal(second.status, "completed");
      assert.match(requests.at(-1)?.bodyText ?? "", /remember first Linux request/);
      assert.match(requests.at(-1)?.bodyText ?? "", /Bash/);
      assert.doesNotMatch(requests.at(-1)?.bodyText ?? "", /PowerShell syntax/);
      await stat(path.join(state, "sessions", "sessions", "linux-session-test", "events.jsonl"));
    } finally {
      await runtime?.coordinator.closeSession("cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores snapshots of Linux files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-undo-"));
    try {
      await writeFile(path.join(root, "Readme"), "before");
      const store = createSnapshotStore({
        workspaceRoot: root,
        sessionDirectory: path.join(root, "session"),
      });
      assert.equal((await store.capture({ runId: "run-one", relativePath: "Readme" })).ok, true);
      await writeFile(path.join(root, "Readme"), "after");
      assert.equal(
        (await undoSessionChanges({ workspaceRoot: root, store, runIds: ["run-one"] })).ok,
        true,
      );
      assert.equal(await readFile(path.join(root, "Readme"), "utf8"), "before");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses undo through a symlink replaced after snapshot capture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-undo-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "lycwl-linux-undo-outside-"));
    try {
      await writeFile(path.join(root, "target"), "original");
      await writeFile(path.join(outside, "target"), "keep-outside");
      const store = createSnapshotStore({
        workspaceRoot: root,
        sessionDirectory: path.join(root, "session"),
      });
      assert.equal((await store.capture({ runId: "one", relativePath: "target" })).ok, true);
      await unlink(path.join(root, "target"));
      await symlink(path.join(outside, "target"), path.join(root, "target"));
      const result = await undoSessionChanges({ workspaceRoot: root, store, runIds: ["one"] });
      assert.equal(result.ok, false);
      assert.equal(await readFile(path.join(outside, "target"), "utf8"), "keep-outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("uses Wayland PNG clipboard with filtered environment and handles unavailable tools", async () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(10, 16);
    png.writeUInt32BE(10, 20);
    const reader = createClipboardReader({
      environment: { WAYLAND_DISPLAY: "wayland-1", GITHUB_TOKEN: "secret" },
      execute: async (command, args, env) => {
        assert.equal(command, "wl-paste");
        assert.ok(args.includes("image/png"));
        assert.equal(env["GITHUB_TOKEN"], undefined);
        return png;
      },
    });
    assert.equal((await reader.readImage()).kind, "image");
    const missing = createClipboardReader({
      environment: { DISPLAY: ":0" },
      execute: async () => {
        throw new Error("not installed");
      },
    });
    assert.equal((await missing.readImage()).kind, "unavailable");
  });
});
