import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { linuxDirectories } from "../../src/adapters/linux/directories.ts";
import {
  createLinuxFileReader,
  createLinuxFsAdapter,
  createLinuxMutationAdapter,
  createLinuxWriteAdapter,
} from "../../src/adapters/linux/filesystem.ts";
import { createProcessSupervisor } from "../../src/adapters/linux/process-supervisor.ts";
import { acquireExclusiveFileLease } from "../../src/adapters/platform-file-lease.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { renderHarnessRules } from "../../src/domain/context/harness-rules.ts";
import { filterChildEnvironment } from "../../src/domain/process/shell.ts";
import { availableTools } from "../../src/domain/tool-catalog/tool-catalog.ts";
import { resolveWorkspacePath } from "../../src/services/permission/workspace-path.ts";

describe("Linux platform adapters", { skip: process.platform !== "linux" }, () => {
  it("uses XDG config and state roots", () => {
    assert.deepEqual(
      linuxDirectories({ HOME: "/home/test", XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" }),
      {
        config: "/cfg/lycwl-agent",
        state: "/state/lycwl-agent",
      },
    );
    assert.deepEqual(linuxDirectories({ HOME: "/home/test" }), {
      config: "/home/test/.config/lycwl-agent",
      state: "/home/test/.local/state/lycwl-agent",
    });
  });

  it("preserves POSIX path case and detects escapes", () => {
    assert.deepEqual(resolveWorkspacePath("/tmp/work", "Readme.md"), {
      ok: true,
      value: {
        absolutePath: "/tmp/work/Readme.md",
        workspaceRoot: "/tmp/work",
        withinWorkspace: true,
        isDirectory: false,
      },
    });
    const outside = resolveWorkspacePath("/tmp/work", "../../etc/passwd");
    assert.equal(outside.ok && outside.value.withinWorkspace, false);
  });

  it("keeps Windows UNC and default model instructions unchanged", () => {
    const windows = resolveWorkspacePath("//server/share/work", "src/file.ts");
    assert.equal(windows.ok, true);
    if (windows.ok)
      assert.equal(windows.value.absolutePath, "\\\\server\\share\\work\\src\\file.ts");
    assert.match(renderHarnessRules(), /PowerShell syntax, not POSIX/);
    assert.doesNotMatch(renderHarnessRules("linux"), /PowerShell/);
    assert.match(
      availableTools(() => true).find((tool) => tool.name === "shell")?.description ?? "",
      /Windows PowerShell 5\.1/,
    );
    assert.match(
      availableTools(() => true, "linux").find((tool) => tool.name === "shell")?.description ?? "",
      /Bash.*--noprofile/,
    );
  });

  it("fails closed instead of loading Win32 libraries", async () => {
    // Imported dynamically so the assertion covers module evaluation itself: a
    // top-level koffi.load would reject here before the bindings could be called.
    const bindings = await import("../../src/adapters/windows/koffi-bindings.ts");
    assert.throws(
      () => bindings.CreateJobObjectW(null, null),
      /Win32 bindings are unavailable on linux/,
    );
    const credentials = await import("../../src/adapters/windows/credential-manager-bindings.ts");
    assert.throws(
      () => credentials.GetLastError(),
      /Windows credential bindings are unavailable on linux/,
    );
  });

  it("preserves environment case while filtering secrets and shell startup injection", () => {
    const result = filterChildEnvironment(
      {
        Path: "/bin",
        PATH: "/usr/bin",
        GITHUB_TOKEN: "secret",
        BASH_ENV: "/tmp/attacker.sh",
        FOO: "one",
      },
      {},
      { platform: "linux" },
    );
    assert.deepEqual(result.environment, { Path: "/bin", PATH: "/usr/bin", FOO: "one" });
    assert.deepEqual(result.removedNames, ["BASH_ENV", "GITHUB_TOKEN"]);
  });

  it("reads, writes and mutates case-distinct files without following symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-fs-"));
    try {
      const reader = createLinuxFileReader({ workspaceRoot: root });
      const fs = createLinuxFsAdapter({ workspaceRoot: root });
      const writer = createLinuxWriteAdapter({ workspaceRoot: root });
      const mutator = createLinuxMutationAdapter({ workspaceRoot: `${root}/` });
      await writer.writeBytes("Readme", Buffer.from("upper"));
      await writer.writeBytes("README", Buffer.from("lower"));
      assert.match((await reader.readText("Readme")) ?? "", /upper/);
      assert.match((await reader.readText("README")) ?? "", /lower/);
      await chmod(path.join(root, "Readme"), 0o600);
      await writer.writeBytes("Readme", Buffer.from("changed"));
      assert.equal((await lstat(path.join(root, "Readme"))).mode & 0o777, 0o600);
      await symlink("README", path.join(root, "linked"));
      const link = await fs.inspect("linked");
      assert.equal(link.ok && link.snapshot.isSymbolicLink, true);
      const deletion = await mutator.inspectDeleteTargets(["linked"]);
      assert.equal(deletion[0]?.isSymbolicLink, true);
      assert.equal(await readFile(path.join(root, "Readme"), "utf8"), "changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("locks files across processes through flock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-lock-"));
    try {
      const first = await acquireExclusiveFileLease(path.join(root, "test.lock"));
      await assert.rejects(
        acquireExclusiveFileLease(path.join(root, "test.lock"), { timeoutMs: 0 }),
        /lock_busy/,
      );
      first.release();
      const second = await acquireExclusiveFileLease(path.join(root, "test.lock"), {
        timeoutMs: 0,
      });
      second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supervises Bash output, failures and timeout", async () => {
    const supervisor = createProcessSupervisor();
    const environment = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
    const success = await supervisor.runToCompletion({
      command: "printf linux-ok",
      cwd: process.cwd(),
      environment,
      timeoutMs: 2_000,
    });
    assert.equal(success.kind, "completed");
    if (success.kind === "completed") {
      assert.equal(success.exitCode, 0);
      assert.equal(success.stdout, "linux-ok");
    }
    const failure = await supervisor.runToCompletion({
      command: "printf before-failure; exit 7",
      cwd: process.cwd(),
      environment,
      timeoutMs: 2_000,
    });
    assert.equal(failure.kind === "completed" && failure.exitCode, 7);
    const timeout = await supervisor.runToCompletion({
      command: "sleep 30",
      cwd: process.cwd(),
      environment,
      timeoutMs: 500,
    });
    assert.equal(timeout.kind === "completed" && timeout.timedOut, true);
  });

  it("rejects a shell cwd whose symlink resolves outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-cwd-"));
    const outside = await mkdtemp(path.join(tmpdir(), "lycwl-linux-outside-"));
    try {
      await symlink(outside, path.join(root, "escape"));
      const tools = createWorkspaceTools({
        workspaceRoot: root,
        approvals: { decide: async () => "approved" },
        ids: { create: () => "id" },
        enableWrites: true,
        enableProcesses: true,
      });
      const result = await tools.execute({
        toolCallId: "shell-cwd",
        toolName: "shell",
        arguments: { command: "pwd", cwd: "escape" },
      });
      assert.equal(result.status, "failed");
      if (result.status === "failed") assert.equal(result.safeCode, "invalid_cwd");
      await tools.cancelAll?.();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
