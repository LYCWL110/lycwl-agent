import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSearchTools } from "../../src/adapters/tools/search-tools.ts";
import { createProcessSupervisor } from "../../src/adapters/windows/process-supervisor.ts";
import { projectApprovalGrants } from "../../src/application/coordinator/approval-grants.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import type { ProviderToolCall } from "../../src/ports/model-provider.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-safety-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runtime(
  root: string,
  calls: readonly ProviderToolCall[],
  options: {
    suspend?: boolean;
    decide?: () => Promise<"approved" | "denied">;
  } = {},
) {
  const ids = new SequenceIds("safety");
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    ids,
    enableWrites: true,
    enableProcesses: true,
    approvals: {
      decide: async () => {
        throw new Error("inline approval must not be used");
      },
    },
  });
  const provider = new ScriptedProvider([
    { kind: "completed", toolCalls: calls, text: null },
    { kind: "completed", toolCalls: [], text: "done" },
  ]);
  const coordinator = new RuntimeCoordinator({
    ids,
    tools,
    provider,
    approvals: { decide: options.decide ?? (async () => "approved") },
    eventLog: new InMemoryEventLog(ids, new JsonDigest()),
    nowUtc: () => new Date().toISOString(),
    suspendOnApproval: options.suspend ?? false,
    runBinding: {
      providerId: "fixture",
      modelId: "fixture",
      protocolId: "fixture",
      adapterVersion: "1",
      endpoint: { scheme: "https", host: "fixture.invalid", port: null, path: "/" },
      endpointFingerprint: "a".repeat(64),
      catalog: { snapshotId: "fixture", sha256: "b".repeat(64) },
      capabilities: { snapshotId: "fixture", sha256: "c".repeat(64) },
      credential: { credentialRef: "fixture", revision: 1 },
    },
    resolveCredentialRevision: async () => 1,
    requestFingerprint: async (value) => JSON.stringify(value),
  });
  return { coordinator, tools, provider };
}

async function waitFor(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition_timeout");
    await delay(10);
  }
}
const call = (toolName: string, args: unknown, id = "call") => ({
  toolName,
  arguments: args,
  providerToolCallId: id,
});
function pendingApproval(coordinator: RuntimeCoordinator) {
  const pending = coordinator.pendingApprovalView();
  assert.ok(pending);
  return pending;
}

describe("search safety at the real composition boundary", () => {
  it("never reads protected files through grep and reports skipped scope", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, ".env"), "SENSITIVE_AUDIT_MARKER");
      await mkdir(path.join(root, ".git"));
      await writeFile(path.join(root, ".git", "config"), "SENSITIVE_AUDIT_MARKER");
      await writeFile(path.join(root, ".env.example"), "SAFE_AUDIT_MARKER");
      const { tools } = runtime(root, []);
      const result = await tools.execute({
        toolCallId: "grep",
        toolName: "grep",
        arguments: { pattern: "AUDIT_MARKER" },
      });
      assert.equal(result.status, "succeeded");
      assert.doesNotMatch(result.text ?? "", /SENSITIVE_AUDIT_MARKER/);
      assert.match(result.text ?? "", /SAFE_AUDIT_MARKER/);
      assert.match(result.text ?? "", /scope=partial.*skipped=/);
    }));

  it("honours ignores, nested negation, .ignore precedence and directory-only rules", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "vendor"));
      await writeFile(
        path.join(root, ".gitignore"),
        "vendor/\n*.log\nblocked.txt\nonly-directory/\n",
      );
      await writeFile(path.join(root, ".ignore"), "!blocked.txt\n");
      await writeFile(path.join(root, "src", ".gitignore"), "!keep.log\n");
      for (const name of [
        "vendor/hidden.txt",
        "src/keep.log",
        "src/drop.log",
        "blocked.txt",
        "only-directory",
      ]) {
        await writeFile(path.join(root, name), "SEARCH_AUDIT_MARKER");
      }
      const { tools } = runtime(root, []);
      const result = await tools.execute({
        toolCallId: "grep",
        toolName: "grep",
        arguments: { pattern: "SEARCH_AUDIT_MARKER" },
      });
      assert.match(result.text ?? "", /src\/keep.log/);
      assert.match(result.text ?? "", /blocked.txt/);
      assert.match(result.text ?? "", /only-directory/);
      assert.doesNotMatch(result.text ?? "", /vendor\/hidden|src\/drop/);
      assert.match(result.text ?? "", /ignored=/);
    }));

  it("reloads changed ignore files at the next invocation", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "file.txt"), "marker");
      const { tools } = runtime(root, []);
      const query = { toolCallId: "glob", toolName: "glob", arguments: { pattern: "*.txt" } };
      assert.match((await tools.execute(query)).text ?? "", /file.txt/);
      await writeFile(path.join(root, ".gitignore"), "*.txt");
      assert.doesNotMatch((await tools.execute(query)).text ?? "", /file.txt/);
    }));

  it("supports character classes and escaping without reopening an excluded parent", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, "excluded"));
      await writeFile(
        path.join(root, ".gitignore"),
        "file[0-9].txt\n\\!literal.txt\nexcluded/\n!excluded/keep.txt\n",
      );
      for (const name of ["file1.txt", "filea.txt", "!literal.txt", "excluded/keep.txt"])
        await writeFile(path.join(root, name), "unique_marker");
      const { tools } = runtime(root, []);
      const result = await tools.execute({
        toolCallId: "ignore",
        toolName: "grep",
        arguments: { pattern: "unique_marker" },
      });
      assert.match(result.text ?? "", /filea.txt/);
      assert.doesNotMatch(result.text ?? "", /file1.txt|!literal.txt|excluded\/keep/);
      const explicit = await tools.execute({
        toolCallId: "explicit",
        toolName: "glob",
        arguments: { path: "excluded", pattern: "**" },
      });
      assert.doesNotMatch(explicit.text ?? "", /keep.txt/);
    }));

  it("does not search a directory whose ignore rules cannot be read", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, ".gitignore"));
      await writeFile(path.join(root, "secret.txt"), "must_not_be_searched");
      const { tools } = runtime(root, []);
      const result = await tools.execute({
        toolCallId: "incomplete",
        toolName: "grep",
        arguments: { pattern: "must_not_be_searched" },
      });
      assert.match(result.text ?? "", /scope=partial.*ignoreRules=incomplete/);
      assert.doesNotMatch(result.text ?? "", /secret.txt:/);
    }));

  it("does not follow a junction to files outside the workspace", () =>
    fixture(async (root) => {
      const outside = await mkdtemp(path.join(tmpdir(), "lycwl-outside-"));
      try {
        await writeFile(path.join(outside, "file.txt"), "outside_marker");
        await symlink(outside, path.join(root, "link"), "junction");
        const { tools } = runtime(root, []);
        const result = await tools.execute({
          toolCallId: "junction",
          toolName: "grep",
          arguments: { pattern: "outside_marker" },
        });
        assert.doesNotMatch(result.text ?? "", /outside_marker/);
        assert.match(result.text ?? "", /scope=partial.*skipped=/);
      } finally {
        await rm(path.join(root, "link"), { force: true, recursive: true });
        await rm(outside, { recursive: true, force: true });
      }
    }));

  it("rejects malformed search parameters", () =>
    fixture(async (root) => {
      const { tools } = runtime(root, []);
      for (const request of [
        call("list_dir", { depth: 0 }),
        call("grep", { pattern: "x", regex: "yes" }),
        call("glob", { pattern: "*", unexpected: true }),
      ]) {
        const result = await tools.execute({ ...request, toolCallId: request.providerToolCallId });
        assert.equal(result.status, "failed");
      }
    }));
});

describe("interactive sensitive reads and immutable approval conditions", () => {
  it("waits for TUI approval before returning a sensitive file", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, ".env"), "SYNTHETIC_APPROVED_MARKER");
      const { coordinator } = runtime(root, [call("read_file", { path: ".env" })], {
        suspend: true,
      });
      const running = coordinator.run("read the synthetic file");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      const pending = pendingApproval(coordinator);
      assert.equal(pending.toolName, "read_file");
      const waitingEvents = coordinator.currentRunProjection()?.events ?? [];
      assert.equal(
        waitingEvents.some((event) => event.payload.kind === "tool_execution_started"),
        false,
      );
      await coordinator.replyApproval({ commandId: "approve", ...pending, decision: "approved" });
      const result = await running;
      assert.equal(result.status, "completed");
      assert.ok(
        result.events.some(
          (event) =>
            event.payload.kind === "tool_execution_finished" &&
            event.payload.text?.includes("SYNTHETIC_APPROVED_MARKER"),
        ),
      );
    }));

  it("denies a sensitive read without returning its content", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, ".env"), "SYNTHETIC_DENIED_MARKER");
      const { coordinator } = runtime(root, [call("read_file", { path: ".env" })], {
        decide: async () => "denied",
      });
      const result = await coordinator.run("deny the read");
      assert.equal(JSON.stringify(result.events).includes("SYNTHETIC_DENIED_MARKER"), false);
      assert.equal(
        result.events.some((event) => event.payload.kind === "tool_execution_started"),
        false,
      );
    }));

  it("revokes stale edit approval and waits for a new explicit decision", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "file.txt"), "before needle");
      const { coordinator } = runtime(
        root,
        [call("edit_file", { path: "file.txt", oldText: "needle", newText: "replacement" })],
        { suspend: true },
      );
      const running = coordinator.run("edit the file");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      const first = pendingApproval(coordinator);
      await writeFile(path.join(root, "file.txt"), "external needle");
      await coordinator.replyApproval({ commandId: "first", ...first, decision: "approved" });
      await waitFor(() => {
        const next = coordinator.pendingApprovalView();
        return next !== null && next.approvalId !== first.approvalId;
      });
      assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "external needle");
      const second = pendingApproval(coordinator);
      await coordinator.replyApproval({ commandId: "second", ...second, decision: "denied" });
      const result = await running;
      assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "external needle");
      const grants = projectApprovalGrants(result.events);
      assert.equal(grants.ok, true);
      if (grants.ok) assert.equal(grants.grants[first.approvalId], "revoked");
    }));

  it("does not execute later siblings after a write denial", () =>
    fixture(async (root) => {
      let decisions = 0;
      const { coordinator } = runtime(
        root,
        [
          call("create_file", { path: "first.txt", content: "first" }, "first"),
          call("create_file", { path: "second.txt", content: "second" }, "second"),
        ],
        {
          decide: async () => {
            decisions += 1;
            return "denied";
          },
        },
      );
      await coordinator.run("deny the first mutation");
      assert.equal(decisions, 1);
      assert.equal(existsSync(path.join(root, "second.txt")), false);
    }));

  for (const toolName of ["read_file", "apply_patch"] as const) {
    it(`requires a fresh ${toolName} decision after the previewed file changes`, () =>
      fixture(async (root) => {
        const name = toolName === "read_file" ? ".env" : "file.txt";
        await writeFile(path.join(root, name), "needle\n");
        const args =
          toolName === "read_file"
            ? { path: name }
            : { patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-needle\n+replacement\n" };
        const { coordinator } = runtime(root, [call(toolName, args)], { suspend: true });
        const running = coordinator.run("test stale approval");
        await waitFor(() => coordinator.pendingApprovalView() !== null);
        const first = pendingApproval(coordinator);
        await writeFile(path.join(root, name), "needle\nexternal\n");
        await coordinator.replyApproval({ commandId: "first", ...first, decision: "approved" });
        await waitFor(() => {
          const next = coordinator.pendingApprovalView();
          return next !== null && next.approvalId !== first.approvalId;
        });
        await coordinator.replyApproval({
          commandId: "second",
          ...pendingApproval(coordinator),
          decision: "denied",
        });
        const result = await running;
        assert.equal(await readFile(path.join(root, name), "utf8"), "needle\nexternal\n");
        assert.equal(
          result.events.some((event) => event.payload.kind === "tool_execution_started"),
          false,
        );
      }));
  }

  it("never converts an invalid create preview into a valid write after approval", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "exists.txt"), "original");
      const { coordinator } = runtime(
        root,
        [call("create_file", { path: "exists.txt", content: "unapproved" })],
        { suspend: true },
      );
      const running = coordinator.run("invalid create");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      await rm(path.join(root, "exists.txt"));
      await coordinator.replyApproval({
        commandId: "approve",
        ...pendingApproval(coordinator),
        decision: "approved",
      });
      assert.equal((await running).status, "completed");
      assert.equal(existsSync(path.join(root, "exists.txt")), false);
    }));

  for (const toolName of ["delete_path", "rename_path"] as const) {
    it(`binds ${toolName} approval to the original file state`, () =>
      fixture(async (root) => {
        await writeFile(path.join(root, "file.txt"), "original");
        const args =
          toolName === "delete_path"
            ? { paths: ["file.txt"] }
            : { from: "file.txt", to: "renamed.txt" };
        const { coordinator } = runtime(root, [call(toolName, args)], { suspend: true });
        const running = coordinator.run("stale mutation");
        await waitFor(() => coordinator.pendingApprovalView() !== null);
        const first = pendingApproval(coordinator);
        await writeFile(path.join(root, "file.txt"), "external replacement");
        await coordinator.replyApproval({ commandId: "first", ...first, decision: "approved" });
        await waitFor(() => {
          const next = coordinator.pendingApprovalView();
          return next !== null && next.approvalId !== first.approvalId;
        });
        await coordinator.replyApproval({
          commandId: "second",
          ...pendingApproval(coordinator),
          decision: "denied",
        });
        await running;
        assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "external replacement");
      }));
  }

  it("requires new approval when a file is replaced with identical bytes", () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "file.txt"), "needle");
      const { coordinator } = runtime(
        root,
        [call("edit_file", { path: "file.txt", oldText: "needle", newText: "replacement" })],
        { suspend: true },
      );
      const running = coordinator.run("replaced identity");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      const first = pendingApproval(coordinator);
      await rename(path.join(root, "file.txt"), path.join(root, "previous.txt"));
      await writeFile(path.join(root, "file.txt"), "needle");
      await coordinator.replyApproval({ commandId: "first", ...first, decision: "approved" });
      await waitFor(() => {
        const next = coordinator.pendingApprovalView();
        return next !== null && next.approvalId !== first.approvalId;
      });
      await coordinator.replyApproval({
        commandId: "second",
        ...pendingApproval(coordinator),
        decision: "denied",
      });
      await running;
      assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "needle");
    }));

  it("cancels a pending approval without requiring a reply", () =>
    fixture(async (root) => {
      const { coordinator } = runtime(
        root,
        [call("create_file", { path: "never.txt", content: "x" })],
        { suspend: true },
      );
      const running = coordinator.run("cancel pending approval");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      await coordinator.cancelRun("cancel");
      const cancelled = await running;
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.events.some((event) => event.payload.kind === "tool_call_cancelled"));
      assert.equal(existsSync(path.join(root, "never.txt")), false);
    }));

  it("does not execute changed arguments under a previously prepared write", () =>
    fixture(async (root) => {
      const { tools } = runtime(root, []);
      const request = {
        toolCallId: "bound",
        toolName: "create_file",
        arguments: { path: "first.txt", content: "original" },
      };
      await tools.preview?.(request);
      const changed = {
        ...request,
        arguments: { path: "other.txt", content: "changed" },
        approvalGranted: true,
      };
      assert.equal(await tools.revalidateApproval?.(changed), false);
      assert.equal((await tools.execute(changed)).status, "failed");
      assert.equal(existsSync(path.join(root, "other.txt")), false);
    }));
});

describe("real PowerShell execution and cancellation", () => {
  it("previews the launch command and guarded pipes without file redirection", () =>
    fixture(async (root) => {
      const { tools } = runtime(root, []);
      const request = {
        toolCallId: "launch",
        toolName: "shell",
        arguments: { command: "Write-Output 'launch-marker'", cwd: "." },
      };
      const preview = await tools.preview?.(request);
      assert.ok(preview);
      assert.match(preview, /-NoProfile -NonInteractive -OutputFormat Text -Command /);
      assert.match(preview, /Write-Output 'launch-marker'/);
      assert.match(preview, /outputEncoding=utf-8/);
      assert.match(preview, /capture=guarded memory pipes/);
      assert.doesNotMatch(preview, /lycwl-(out|err)-/);
      const result = await tools.execute({ ...request, approvalGranted: true });
      assert.equal(result.status, "succeeded");
      assert.match(result.text ?? "", /launch-marker/);
    }));

  it("does not spawn when the signal is already aborted", () =>
    fixture(async (root) => {
      const result = await createProcessSupervisor().runToCompletion({
        command: "Set-Content 'never.txt' 'bad'",
        cwd: root,
        environment: {},
        timeoutMs: 1000,
        signal: AbortSignal.abort(),
      });
      assert.equal(result.kind, "failed");
      assert.equal(existsSync(path.join(root, "never.txt")), false);
    }));

  it("requires new approval if cwd is replaced while the decision is pending", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, "sub"));
      const { coordinator } = runtime(
        root,
        [call("shell", { command: "Set-Content 'never.txt' 'bad'", cwd: "sub" })],
        { suspend: true },
      );
      const running = coordinator.run("stale cwd");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      const first = pendingApproval(coordinator);
      await rename(path.join(root, "sub"), path.join(root, "old"));
      await mkdir(path.join(root, "sub"));
      await coordinator.replyApproval({ commandId: "first", ...first, decision: "approved" });
      await waitFor(() => {
        const next = coordinator.pendingApprovalView();
        return next !== null && next.approvalId !== first.approvalId;
      });
      await coordinator.replyApproval({
        commandId: "second",
        ...pendingApproval(coordinator),
        decision: "denied",
      });
      await running;
      assert.equal(existsSync(path.join(root, "sub", "never.txt")), false);
    }));

  it("supports PowerShell and resolves cwd relative to the Session workspace", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, "sub"));
      const { tools } = runtime(root, []);
      const result = await tools.execute({
        toolCallId: "shell",
        toolName: "shell",
        arguments: {
          command: "Write-Output (Get-Location).Path; Write-Output '中文输出'",
          cwd: "sub",
        },
      });
      assert.equal(result.status, "succeeded");
      assert.ok(result.text?.includes(path.join(root, "sub")));
      assert.match(result.text ?? "", /中文输出/);
    }));

  it("interrupts the running process before its delayed side effect", () =>
    fixture(async (root) => {
      const command =
        "Write-Output 'started'; Start-Sleep -Seconds 3; Set-Content -LiteralPath 'after-cancel.txt' -Value 'must not happen'";
      const { coordinator, provider } = runtime(root, [
        call("shell", { command, cwd: ".", timeoutMs: 10000 }),
        call("create_file", { path: "sibling.txt", content: "never" }, "sibling"),
      ]);
      const running = coordinator.run("cancel a running process");
      await waitFor(
        () =>
          coordinator
            .currentRunProjection()
            ?.events.some((event) => event.payload.kind === "tool_execution_started") === true,
      );
      await delay(300);
      const started = Date.now();
      await coordinator.cancelRun("cancel-running");
      const result = await running;
      assert.equal(result.status, "cancelled");
      assert.ok(Date.now() - started < 2500);
      assert.equal(existsSync(path.join(root, "after-cancel.txt")), false);
      assert.ok(
        result.events.some(
          (event) =>
            event.payload.kind === "tool_execution_finished" &&
            event.payload.status === "outcome_unknown",
        ),
      );
      await coordinator.run("continue after cancellation");
      const lastRequest = provider.requests.at(-1);
      assert.ok(lastRequest);
      const history = lastRequest.conversation;
      const results = history.filter((item) => item.kind === "tool_result");
      assert.ok(
        results.some(
          (item) => item.providerToolCallId === "call" && item.status === "outcome_unknown",
        ),
      );
      assert.ok(
        results.some(
          (item) => item.providerToolCallId === "sibling" && item.status === "cancelled",
        ),
      );
    }));

  it("terminates a descendant process before its delayed write", () =>
    fixture(async (root) => {
      const child = Buffer.from(
        "Start-Sleep -Seconds 2; Set-Content -LiteralPath 'child-write.txt' -Value 'bad'",
        "utf16le",
      ).toString("base64");
      const command = `$child = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${child}' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath 'child-started.txt' -Value $child.Id; Start-Sleep -Seconds 20`;
      const { coordinator } = runtime(root, [
        call("shell", { command, cwd: ".", timeoutMs: 10000 }),
      ]);
      const running = coordinator.run("cancel process tree");
      await waitFor(() => existsSync(path.join(root, "child-started.txt")));
      await coordinator.cancelRun("cancel-tree");
      assert.equal((await running).status, "cancelled");
      await delay(2300);
      assert.equal(existsSync(path.join(root, "child-write.txt")), false);
    }));

  it("stops a running background task when the owning Run is cancelled", () =>
    fixture(async (root) => {
      const { coordinator } = runtime(
        root,
        [
          call(
            "background_start",
            {
              command:
                "Set-Content 'background-started.txt' 'ready'; Start-Sleep -Seconds 2; Set-Content 'background-write.txt' 'bad'",
              cwd: ".",
              timeoutMs: 10000,
            },
            "background",
          ),
          call("create_file", { path: "pending.txt", content: "never" }, "pending"),
        ],
        { suspend: true },
      );
      const running = coordinator.run("cancel background");
      await waitFor(() => coordinator.pendingApprovalView() !== null);
      await coordinator.replyApproval({
        commandId: "start",
        ...pendingApproval(coordinator),
        decision: "approved",
      });
      await waitFor(() => coordinator.pendingApprovalView()?.toolName === "create_file");
      await waitFor(() => existsSync(path.join(root, "background-started.txt")));
      await coordinator.cancelRun("cancel-background");
      assert.equal((await running).status, "cancelled");
      await delay(2300);
      assert.equal(existsSync(path.join(root, "background-write.txt")), false);
      assert.equal(existsSync(path.join(root, "pending.txt")), false);
    }));
});

describe("terminable regex computation", () => {
  it("retains confirmed hits and unsearched files after a timeout", async () => {
    const tools = createSearchTools({
      listEntries: async () =>
        ["a.txt", "b.txt", "c.txt"].map((name) => ({ path: name, kind: "file" as const })),
      readText: async (name) => (name === "a.txt" ? "aaa" : `${"a".repeat(40)}!`),
      regexTimeoutMs: 250,
    });
    const result = await tools.execute({
      toolCallId: "partial",
      toolName: "grep",
      arguments: { pattern: "(a+)+$", regex: true },
    });
    assert.equal(result.status, "failed");
    assert.match(result.text ?? "", /a.txt:1:aaa/);
    assert.match(result.text ?? "", /scope=partial/);
    assert.match(result.text ?? "", /unsearchedPath=b.txt/);
    assert.match(result.text ?? "", /unsearchedPath=c.txt/);
  });

  it("settles if the worker times out while filesystem work is pending", async () => {
    const tools = createSearchTools({
      listEntries: async () => [{ path: "file.txt", kind: "file" }],
      readText: async () => {
        await delay(200);
        return "aaa";
      },
      regexTimeoutMs: 100,
    });
    const result = await tools.execute({
      toolCallId: "idle-timeout",
      toolName: "grep",
      arguments: { pattern: "a+", regex: true },
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.safeCode, "search_timeout");
  });

  it("keeps the event loop responsive and terminates a pathological regex", async () => {
    const tools = createSearchTools({
      listEntries: async () => [{ path: "file.txt", kind: "file" }],
      readText: async () => `${"a".repeat(40)}!`,
      regexTimeoutMs: 250,
    });
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 50);
    const start = Date.now();
    const result = await tools.execute({
      toolCallId: "regex",
      toolName: "grep",
      arguments: { pattern: "(a+)+$", regex: true },
    });
    clearTimeout(timer);
    assert.equal(ticked, true);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.safeCode, "search_timeout");
    assert.ok(Date.now() - start < 3000);
  });

  it("aborts a regex Worker on Run cancellation", async () => {
    const controller = new AbortController();
    const tools = createSearchTools({
      listEntries: async () => [{ path: "file.txt", kind: "file" }],
      readText: async () => `${"a".repeat(40)}!`,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await tools.execute({
      toolCallId: "regex",
      toolName: "grep",
      arguments: { pattern: "(a+)+$", regex: true },
      signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.safeCode, "search_cancelled");
  });
});
