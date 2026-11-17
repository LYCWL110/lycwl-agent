import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { createGuidanceLoader } from "../../src/adapters/windows/guidance-loader.ts";
import { createWindowsMutationAdapter } from "../../src/adapters/windows/windows-mutation-adapter.ts";
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

const KEY = "SYNTHETIC_PROTECTED_KEY_20261107";
const OLD_KEY = "SYNTHETIC_RETIRED_KEY_20261107";
const settings = {
  provider: {
    protocol: "openai_chat",
    model: "fixture",
    baseUrl: "https://fixture.invalid",
    credentialRef: "fixture-key",
    contextWindow: 128000,
  },
};
const response = (text: string | null, calls: unknown[] = []) => ({
  ok: true as const,
  status: 200,
  headers: {},
  wireBytes: 0,
  bodyText: JSON.stringify({
    choices: [
      {
        finish_reason: calls.length ? "tool_calls" : "stop",
        message: { content: text, ...(calls.length ? { tool_calls: calls } : {}) },
      },
    ],
  }),
});
const call = (name: string, args: unknown) => ({
  id: "fixture-call",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-high-risk-"));
  try {
    await body(root);
  } finally {
    await closeRuntimeSelections();
    await rm(root, { recursive: true, force: true });
  }
}
async function runtime(
  root: string,
  post: NonNullable<Parameters<typeof selectRuntime>[0]["post"]>,
  secret = KEY,
) {
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  const vault = createFileVault({ directory: data });
  if (
    !(await vault.read({ reference: "fixture-key", purpose: "provider_api_key", revision: 1 })).ok
  )
    assert.equal(
      (
        await vault.write({
          reference: "fixture-key",
          purpose: "provider_api_key",
          secret,
        })
      ).ok,
      true,
    );
  const selected = await selectRuntime({
    workspaceRoot: workspace,
    dataDirectory: data,
    settings,
    hasSettings: true,
    post,
  });
  assert.equal(selected.kind, "real");
  if (selected.kind !== "real") throw new Error("fixture_selection");
  return { coordinator: selected.coordinator, workspace, data, vault };
}
async function decide(
  coordinator: Awaited<ReturnType<typeof runtime>>["coordinator"],
  decision: "approved" | "denied",
) {
  const end = Date.now() + 5000;
  while (coordinator.pendingApprovalView() === null) {
    assert.ok(Date.now() < end, "approval_timeout");
    await delay(5);
  }
  const pending = coordinator.pendingApprovalView()!;
  assert.equal(
    (
      await coordinator.replyApproval({
        ...pending,
        commandId: "fixture-reply",
        decision,
      })
    ).ok,
    true,
  );
}

describe("production owned-key wiring", () => {
  it("withholds tool output before persistence and prevents a second send", () =>
    fixture(async (root) => {
      let sends = 0;
      const { coordinator, workspace } = await runtime(root, async () => {
        sends += 1;
        return response(null, [call("read_file", { path: "file.txt" })]);
      });
      await writeFile(path.join(workspace, "file.txt"), KEY);
      const result = await coordinator.run("read fixture");
      assert.equal(result.status, "waiting");
      assert.equal(result.run.state, "waiting");
      assert.equal(sends, 1);
      assert.equal(JSON.stringify(result.events).includes(KEY), false);
      const finished = result.events.find(
        (event) => event.payload.kind === "tool_execution_finished",
      );
      assert.ok(finished?.payload.kind === "tool_execution_finished");
      assert.equal(finished.payload.status, "succeeded");
      assert.equal(finished.payload.text, null);
    }));

  it("protects a sensitive read after approval resumes execution", () =>
    fixture(async (root) => {
      let sends = 0;
      const { coordinator, workspace } = await runtime(root, async () => {
        sends += 1;
        return response(null, [call("read_file", { path: ".env" })]);
      });
      await writeFile(path.join(workspace, ".env"), KEY);
      const running = coordinator.run("read synthetic environment");
      await decide(coordinator, "approved");
      const result = await running;
      assert.equal(result.status, "waiting");
      assert.equal(sends, 1);
      assert.equal(JSON.stringify(result.events).includes(KEY), false);
      assert.ok(result.events.some((event) => event.payload.kind === "tool_execution_finished"));
    }));

  for (const scenario of ["text", "arguments", "tool-name"] as const) {
    it(`blocks a model key in ${scenario} before any tool dispatch`, () =>
      fixture(async (root) => {
        const { coordinator } = await runtime(root, async () =>
          scenario === "text"
            ? response(KEY)
            : response(null, [call(scenario === "tool-name" ? KEY : "shell", { command: KEY })]),
        );
        const result = await coordinator.run("synthetic task");
        assert.equal(result.status, "waiting");
        assert.equal(result.text, null);
        assert.equal(JSON.stringify(result.events).includes(KEY), false);
        assert.equal(
          result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
          false,
        );
      }));
  }

  for (const encode of [
    (text: string) => Buffer.from(text).toString("base64"),
    (text: string) => Buffer.from(text).toString("base64url"),
  ]) {
    it("blocks registered encoded key representations", () =>
      fixture(async (root) => {
        const { coordinator } = await runtime(root, async () => response(encode(KEY)));
        const result = await coordinator.run("task");
        assert.equal(result.status, "waiting");
        assert.equal(JSON.stringify(result.events).includes(encode(KEY)), false);
      }));
  }

  it("blocks a key in raw tool schemas while preserving trusted authentication", () =>
    fixture(async (root) => {
      let sends = 0;
      const { assembleRuntime } = await import("../../src/bootstrap/runtime-assembly.ts");
      const selected = await runtime(root, async (request) => {
        sends += 1;
        assert.equal(request.headers["authorization"], `Bearer ${KEY}`);
        return response("ok");
      });
      assert.equal((await selected.coordinator.run("task")).status, "completed");
      const assembly = await assembleRuntime({
        settings,
        dataDirectory: selected.data,
        toolDefinitions: [{ name: "fixture", description: KEY, inputSchema: {} }],
        post: async () => {
          sends += 1;
          return response("ok");
        },
      });
      assert.ok(assembly.ok);
      await assert.rejects(
        assembly.provider.complete({
          modelRequestId: "fixture",
          attemptNo: 1,
          conversation: [{ kind: "user", text: "task" }],
        }),
      );
      assert.equal(sends, 1);
    }));

  it("blocks input and project guidance before a Provider send", () =>
    fixture(async (root) => {
      let sends = 0;
      const { coordinator, workspace } = await runtime(root, async () => {
        sends += 1;
        return response("ok");
      });
      assert.equal((await coordinator.run(KEY)).status, "waiting");
      assert.equal(sends, 0);
      await writeFile(path.join(workspace, "AGENTS.md"), KEY);
      const reopened = await runtime(root, async () => {
        sends += 1;
        return response("ok");
      });
      assert.equal((await reopened.coordinator.run("task")).status, "waiting");
      assert.equal(sends, 0);
    }));

  it("refreshes protection after an in-flight key rotation and retains old values after restart", () =>
    fixture(async (root) => {
      let vault: ReturnType<typeof createFileVault>;
      const selected = await runtime(
        root,
        async () => {
          await vault.write({ reference: "fixture-key", purpose: "provider_api_key", secret: KEY });
          return response(KEY);
        },
        OLD_KEY,
      );
      vault = selected.vault;
      const result = await selected.coordinator.run("task");
      assert.equal(result.status, "waiting");
      assert.equal(JSON.stringify(result.events).includes(KEY), false);
      const reopened = await runtime(root, async () => response(OLD_KEY));
      assert.equal((await reopened.coordinator.run("task")).status, "waiting");
      await vault.remove("fixture-key");
      const protection = await createFileVault({
        directory: selected.data,
      }).readProviderProtection();
      assert.ok(protection.ok && protection.value.keys.some((key) => key.value === OLD_KEY));
      assert.ok(protection.ok && protection.value.keys.some((key) => key.value === KEY));
    }));

  it("fails closed for short keys and unreadable protection state", () =>
    fixture(async (root) => {
      let sends = 0;
      const selected = await runtime(
        root,
        async () => {
          sends += 1;
          return response("ok");
        },
        "x",
      );
      assert.equal((await selected.coordinator.run("text")).status, "waiting");
      assert.equal(sends, 0);
      await assert.rejects(selected.coordinator.run("another task"), /session_busy/u);
      await assert.rejects(selected.coordinator.closeSession("close-short-key"), {
        message: "protected_delivery_blocked",
      });
      await writeFile(selected.vault.filePath, "corrupt");
      const unavailable = await selectRuntime({
        workspaceRoot: selected.workspace,
        dataDirectory: selected.data,
        settings,
        hasSettings: true,
        post: async () => {
          sends++;
          return response("ok");
        },
      });
      assert.equal(unavailable.kind, "demo");
      if (unavailable.kind === "demo") assert.equal(unavailable.reason, "credential_missing");
      assert.equal(sends, 0);
    }));
});

describe("mutation real-path boundaries", () => {
  it("rejects an external junction in both preflight and execution", () =>
    fixture(async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await symlink(outside, path.join(workspace, "link"), "junction");
      await writeFile(path.join(workspace, "source.txt"), "fixture");
      const adapter = createWindowsMutationAdapter({ workspaceRoot: workspace });
      await assert.rejects(adapter.inspectRename("source.txt", "link/moved.txt"));
      await assert.rejects(adapter.renamePath("source.txt", "link/moved.txt"));
      assert.equal(await readFile(path.join(workspace, "source.txt"), "utf8"), "fixture");
    }));

  it("rejects a parent replaced by a junction after inspection", () =>
    fixture(async (root) => {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await mkdir(path.join(workspace, "target"), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(workspace, "source.txt"), "fixture");
      const adapter = createWindowsMutationAdapter({ workspaceRoot: workspace });
      await adapter.inspectRename("source.txt", "target/moved.txt");
      await rename(path.join(workspace, "target"), path.join(workspace, "old-target"));
      await symlink(outside, path.join(workspace, "target"), "junction");
      await assert.rejects(adapter.renamePath("source.txt", "target/moved.txt"));
      assert.equal(await readFile(path.join(workspace, "source.txt"), "utf8"), "fixture");
    }));

  it("still renames ordinary workspace files", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "source.txt"), "fixture");
      const adapter = createWindowsMutationAdapter({ workspaceRoot: root });
      assert.equal((await adapter.inspectRename("source.txt", "moved.txt")).sourceExists, true);
      await adapter.renamePath("source.txt", "moved.txt");
      assert.equal(await readFile(path.join(root, "moved.txt"), "utf8"), "fixture");
    }));
});

describe("automatic guidance read boundaries", () => {
  it("does not load protected guidance after a denied read", () =>
    fixture(async (root) => {
      const marker = "SYNTHETIC_PROTECTED_GUIDANCE";
      const requests: string[] = [];
      const { coordinator, workspace } = await runtime(root, async (request) => {
        requests.push(request.bodyText);
        return requests.length === 1
          ? response(null, [call("read_file", { path: ".git/config" })])
          : response("done");
      });
      await mkdir(path.join(workspace, ".git"));
      await writeFile(path.join(workspace, ".git", "config"), "fixture");
      await writeFile(path.join(workspace, ".git", "AGENTS.md"), marker);
      const running = coordinator.run("inspect fixture");
      await decide(coordinator, "denied");
      const result = await running;
      assert.equal(result.status, "completed");
      assert.equal(requests.length, 2);
      assert.equal(requests.join("").includes(marker), false);
      const loaded = await createGuidanceLoader({ workspaceRoot: workspace }).load({
        targetPath: ".git/config",
        targetIsDirectory: false,
      });
      assert.ok(!loaded.ok && loaded.code === "approval_required");
    }));

  // Windows resolves the link and reports `approval_required`. On Linux the reader
  // refuses the symlink itself with `symbolic_link`, which also fails closed but is
  // a different code, so the assertion is Windows-specific.
  it(
    "checks the resolved destination of an AGENTS.md file link",
    { skip: process.platform !== "win32" },
    (test) =>
      fixture(async (root) => {
        const workspace = path.join(root, "workspace");
        await mkdir(workspace);
        const external = path.join(root, ".env");
        await writeFile(external, "SYNTHETIC_OUTSIDE_SECRET");
        try {
          await symlink(external, path.join(workspace, "AGENTS.md"), "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          test.skip("Windows file symlink privilege unavailable");
          return;
        }
        const result = await createGuidanceLoader({ workspaceRoot: workspace }).load({
          targetPath: workspace,
          targetIsDirectory: true,
        });
        assert.ok(!result.ok && result.code === "approval_required");
        assert.equal(JSON.stringify(result).includes("SYNTHETIC_OUTSIDE_SECRET"), false);
      }),
  );

  // A junction is followed on Windows. On Linux the symlinked directory is not
  // listed at all, so discovery finds no guidance: nothing leaks, but the path is
  // never gated, which makes the Windows assertion inapplicable.
  it(
    "checks protected real paths reached through an internal directory junction",
    { skip: process.platform !== "win32" },
    () =>
      fixture(async (root) => {
        await mkdir(path.join(root, ".git"));
        await writeFile(path.join(root, ".git", "AGENTS.md"), "SYNTHETIC_LINK_SECRET");
        await symlink(path.join(root, ".git"), path.join(root, "alias"), "junction");
        const loaded = await createGuidanceLoader({ workspaceRoot: root }).load({
          targetPath: "alias/file.ts",
          targetIsDirectory: false,
        });
        assert.ok(!loaded.ok && loaded.code === "approval_required");
        assert.equal(JSON.stringify(loaded).includes("SYNTHETIC_LINK_SECRET"), false);
      }),
  );
});
