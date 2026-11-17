import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createLinuxMutationAdapter,
  createLinuxWriteAdapter,
} from "../../src/adapters/linux/filesystem.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { InMemoryEventLog } from "../../src/ports/event-log.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

describe("Linux filesystem tools", { skip: process.platform !== "linux" }, () => {
  it("creates, edits, patches and renames a Linux file without losing executable mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-edit-"));
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: new SequenceIds(),
      enableWrites: true,
    });
    const execute = (toolName: string, args: unknown) =>
      tools.execute({ toolCallId: toolName, toolName, arguments: args });
    try {
      assert.equal(
        (await execute("create_file", { path: "中文 script.sh", content: "echo before\n" })).status,
        "succeeded",
      );
      await chmod(path.join(root, "中文 script.sh"), 0o755);
      assert.equal(
        (
          await execute("edit_file", {
            path: "中文 script.sh",
            oldText: "before",
            newText: "after",
          })
        ).status,
        "succeeded",
      );
      assert.equal((await stat(path.join(root, "中文 script.sh"))).mode & 0o777, 0o755);
      const patch =
        "--- a/中文 script.sh\n+++ b/中文 script.sh\n@@ -1 +1 @@\n-echo after\n+echo patched\n";
      assert.equal((await execute("apply_patch", { patch })).status, "succeeded");
      assert.equal(
        (await execute("rename_path", { from: "中文 script.sh", to: "Renamed.sh" })).status,
        "succeeded",
      );
      assert.equal(await readFile(path.join(root, "Renamed.sh"), "utf8"), "echo patched\n");
      assert.equal((await execute("delete_path", { paths: ["Renamed.sh"] })).status, "succeeded");
      await assert.rejects(stat(path.join(root, "Renamed.sh")), { code: "ENOENT" });
    } finally {
      await tools.cancelAll?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves bytes when a stale write, traversal or symlink mutation is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-conflict-"));
    const outside = await mkdtemp(path.join(tmpdir(), "lycwl-linux-other-"));
    try {
      const writer = createLinuxWriteAdapter({ workspaceRoot: root });
      await writeFile(path.join(root, "file"), "initial");
      const expected = await writer.inspectTarget("file");
      await writeFile(path.join(root, "file"), "external-change");
      assert.deepEqual(await writer.writeBytes("file", Buffer.from("overwrite"), expected), {
        ok: false,
        code: "file_conflict",
      });
      assert.equal(await readFile(path.join(root, "file"), "utf8"), "external-change");
      assert.deepEqual(await writer.writeBytes("../outside.txt", Buffer.from("no")), {
        ok: false,
        code: "invalid_path",
      });
      await symlink(outside, path.join(root, "linked-dir"));
      assert.deepEqual(await writer.writeBytes("linked-dir/out.txt", Buffer.from("no")), {
        ok: false,
        code: "invalid_path",
      });
      await assert.rejects(stat(path.join(outside, "out.txt")), { code: "ENOENT" });
      await symlink("file", path.join(root, "linked-file"));
      assert.deepEqual(await writer.writeBytes("linked-file", Buffer.from("no")), {
        ok: false,
        code: "invalid_path",
      });
      const mutator = createLinuxMutationAdapter({ workspaceRoot: `${root}/` });
      await mutator.renamePath("file", "FILE");
      assert.equal(await readFile(path.join(root, "FILE"), "utf8"), "external-change");
      await mutator.deletePath("FILE");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("applies ignore rules case-sensitively and skips sensitive search files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-search-"));
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "denied" },
      ids: new SequenceIds(),
    });
    try {
      await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
      await writeFile(path.join(root, "ignored.txt"), "invisible-marker");
      await writeFile(path.join(root, "Ignored.txt"), "visible-marker");
      await writeFile(path.join(root, ".env"), "unapproved-secret-marker");
      const result = await tools.execute({
        toolCallId: "glob",
        toolName: "glob",
        arguments: { pattern: "**/*", path: "." },
      });
      assert.equal(result.status, "succeeded");
      assert.match(result.text ?? "", /Ignored\.txt/);
      assert.doesNotMatch(result.text ?? "", /unapproved-secret-marker/);
      const grep = await tools.execute({
        toolCallId: "grep",
        toolName: "grep",
        arguments: { pattern: "invisible-marker", path: "." },
      });
      assert.equal(grep.status, "succeeded");
      assert.doesNotMatch(grep.text ?? "", /invisible-marker/);
    } finally {
      await tools.cancelAll?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not read secrets or execute a mutation denied by the coordinator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-approval-"));
    try {
      await writeFile(path.join(root, ".env"), "fixture-secret-do-not-disclose");
      const ids = new SequenceIds("linux-denial");
      const gate = { decide: async () => "denied" as const };
      const tools = createWorkspaceTools({
        workspaceRoot: root,
        approvals: gate,
        ids,
        enableWrites: true,
      });
      const runtime = new RuntimeCoordinator({
        provider: new ScriptedProvider([
          {
            kind: "completed",
            text: null,
            toolCalls: [
              { providerToolCallId: "read", toolName: "read_file", arguments: { path: ".env" } },
            ],
          },
          {
            kind: "completed",
            text: null,
            toolCalls: [
              {
                providerToolCallId: "write",
                toolName: "create_file",
                arguments: { path: "denied.txt", content: "no" },
              },
            ],
          },
          { kind: "completed", text: "denied", toolCalls: [] },
        ]),
        tools,
        approvals: gate,
        eventLog: new InMemoryEventLog(ids, new JsonDigest()),
        ids,
        nowUtc: () => "2026-11-16T00:00:00.000Z",
        sleep: async () => undefined,
      });
      const result = await runtime.run("try restricted operations");
      assert.equal(result.status, "completed");
      assert.doesNotMatch(JSON.stringify(result.events), /fixture-secret-do-not-disclose/);
      await assert.rejects(stat(path.join(root, "denied.txt")), { code: "ENOENT" });
      await runtime.closeSession("cleanup");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses recursive deletion and moving a directory into itself", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-tree-"));
    const tools = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: new SequenceIds(),
      enableWrites: true,
    });
    try {
      await mkdir(path.join(root, "outer", "inner"), { recursive: true });
      const rename = await tools.execute({
        toolCallId: "rename",
        toolName: "rename_path",
        arguments: { from: "outer", to: "outer/inner/moved" },
      });
      assert.equal(rename.status, "failed");
      const deletion = await tools.execute({
        toolCallId: "delete",
        toolName: "delete_path",
        arguments: { paths: ["outer"], recursive: true },
      });
      assert.equal(deletion.status, "failed");
      assert.equal((await stat(path.join(root, "outer", "inner"))).isDirectory(), true);
    } finally {
      await tools.cancelAll?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
