import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createSnapshotStore } from "../../src/adapters/persistence/snapshot-store.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import type { ModelProvider, ProviderCompletion } from "../../src/ports/model-provider.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-syntax-scope-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

async function coordinatorFor(provider: ModelProvider): Promise<RuntimeCoordinator> {
  const ids = new SequenceIds("scope");
  const eventLog = new InMemoryEventLog(ids, new JsonDigest());
  const approvals = { decide: async () => "approved" as const };
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    approvals,
    ids,
    enableWrites: true,
    enableProcesses: false,
    enableWeb: false,
  });
  const snapshots = createSnapshotStore({
    sessionDirectory: path.join(root, "snapshots"),
    workspaceRoot: root,
  });
  return new RuntimeCoordinator({
    provider,
    tools,
    approvals,
    eventLog,
    ids,
    snapshotStore: snapshots,
    resolveWorkspacePath: (relativePath) => path.join(root, relativePath),
    syntaxChecker: {
      async check(absolutePath) {
        const text = await readFile(absolutePath, "utf8").catch(() => "");
        return text.includes("BROKEN")
          ? { kind: "failed", message: "Broken edit", line: 1 }
          : { kind: "ok" };
      },
    },
    persistReports: true,
    nowUtc: () => "2026-11-26T00:00:00.000Z",
  });
}

function report(coordinatorResult: Awaited<ReturnType<RuntimeCoordinator["run"]>>) {
  const event = coordinatorResult.events.findLast(
    (candidate) => candidate.payload.kind === "task_report_snapshot",
  );
  assert.ok(event?.payload.kind === "task_report_snapshot");
  return event.payload.report;
}

describe("syntax rollback scope", () => {
  it("keeps a successful edit when a later file fails its check", async () => {
    const provider = new ScriptedProvider([
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "a",
            toolName: "create_file",
            arguments: { path: "a.txt", content: "alpha" },
          },
        ],
      },
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "b",
            toolName: "create_file",
            arguments: { path: "b.txt", content: "BROKEN" },
          },
        ],
      },
      { kind: "completed", text: "done", toolCalls: [] },
    ] satisfies ProviderCompletion[]);
    const coordinator = await coordinatorFor(provider);
    const result = await coordinator.run("write a and b");
    try {
      assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "alpha");
      await assert.rejects(readFile(path.join(root, "b.txt"), "utf8"), { code: "ENOENT" });

      const snapshot = report(result);
      assert.deepEqual(
        snapshot.changes.map((change) => change.path),
        ["a.txt"],
      );
      assert.ok(
        snapshot.assertions.some(
          (assertion) =>
            assertion.assertionId.endsWith(":syntax:b.txt") &&
            assertion.state === "failed" &&
            assertion.description.includes("reverted"),
        ),
      );
    } finally {
      await coordinator.closeSession("close");
    }
  });

  it("restores the version before the failed edit, not the Run start", async () => {
    const provider = new ScriptedProvider([
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "create",
            toolName: "create_file",
            arguments: { path: "a.txt", content: "alpha" },
          },
        ],
      },
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "good",
            toolName: "edit_file",
            arguments: { path: "a.txt", oldText: "alpha", newText: "alpha-ok" },
          },
        ],
      },
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "bad",
            toolName: "edit_file",
            arguments: { path: "a.txt", oldText: "alpha-ok", newText: "BROKEN" },
          },
        ],
      },
      { kind: "completed", text: "done", toolCalls: [] },
    ] satisfies ProviderCompletion[]);
    const coordinator = await coordinatorFor(provider);
    const result = await coordinator.run("edit the same file twice");
    try {
      assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "alpha-ok");
      const passed = result.events.filter(
        (event) => event.payload.kind === "syntax_check_passed" && event.payload.path === "a.txt",
      );
      assert.equal(passed.length, 1);
      const snapshot = report(result);
      assert.deepEqual(
        snapshot.changes.map((change) => change.path),
        ["a.txt"],
      );
      assert.equal(
        snapshot.assertions.some(
          (assertion) =>
            assertion.assertionId.endsWith(":syntax:a.txt") &&
            assertion.state === "failed" &&
            assertion.description.includes("reverted"),
        ),
        true,
      );
    } finally {
      await coordinator.closeSession("close");
    }
  });
});
