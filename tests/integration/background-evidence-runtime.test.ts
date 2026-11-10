import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFileEvidenceStore } from "../../src/adapters/persistence/file-evidence-store.ts";
import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import { JsonDigest } from "../fakes/deterministic-services.ts";

async function fixture(
  body: (input: {
    runtime: RuntimeCoordinator;
    log: JsonlEventLog;
    store: ReturnType<typeof createFileEvidenceStore>;
  }) => Promise<void>,
  command: string,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lycwl-background-evidence-"));
  const ids = { create: () => randomUUID() };
  const log = new JsonlEventLog(directory, ids, new JsonDigest());
  const store = createFileEvidenceStore({
    sessionDirectory: path.join(directory, "sessions", "fixture-session"),
    sessionId: "fixture-session",
    ownedKeys: { keys: [] },
    refreshOwnedKeys: async () => {},
  });
  const tools = createWorkspaceTools({
    workspaceRoot: directory,
    approvals: { decide: async () => "approved" },
    ids,
    enableProcesses: true,
    enableWrites: true,
    evidenceStore: store,
  });
  let sends = 0;
  const runtime = new RuntimeCoordinator({
    ids,
    eventLog: log,
    tools,
    approvals: { decide: async () => "approved" },
    sessionId: "fixture-session",
    nowUtc: () => new Date().toISOString(),
    nowMs: () => performance.now(),
    persistReports: true,
    provider: {
      complete: async () =>
        ++sends === 1
          ? {
              kind: "completed",
              text: null,
              toolCalls: [
                {
                  providerToolCallId: "background",
                  toolName: "background_start",
                  arguments: { command, cwd: ".", timeoutMs: 15000 },
                },
              ],
            }
          : { kind: "completed", text: "launched", toolCalls: [] },
    },
  });
  try {
    await body({ runtime, log, store });
  } finally {
    await runtime.closeSession("close");
    await rm(directory, { recursive: true, force: true });
  }
}

function tasks(events: readonly InternalEvent[]) {
  return events.flatMap(({ payload }) =>
    payload.kind === "background_task_observed" ? [payload.task] : [],
  );
}

describe("durable background observations", () => {
  it("records completion once without polling after the launching Run ends", async () => {
    await fixture(async ({ runtime, log, store }) => {
      const result = await runtime.run("launch synthetic background job");
      assert.equal(result.status, "completed");
      const deadline = Date.now() + 15000;
      let events = await log.read("fixture-session");
      while (
        !tasks(events).some((task) => task.state === "succeeded") ||
        events.at(-1)?.payload.kind !== "task_report_snapshot"
      ) {
        assert.ok(Date.now() < deadline, "background terminal event missing");
        await delay(25);
        events = await log.read("fixture-session");
      }
      assert.deepEqual(
        tasks(events).map((task) => task.state),
        ["registered", "running", "succeeded"],
      );
      const terminal = tasks(events).at(-1);
      assert.ok(terminal && terminal.state === "succeeded");
      assert.equal(terminal.ownerRunId, result.events[0]?.runId);
      assert.equal(terminal.exitCode, 0);
      assert.ok("evidence" in terminal && terminal.evidence?.rawComplete);
      assert.deepEqual(await store.verify(terminal.evidence, terminal.launchingToolCallId), {
        ok: true,
      });
      assert.ok(
        events.some(
          ({ payload }) =>
            payload.kind === "tool_dispatch_committed" &&
            payload.toolCallId === terminal.launchingToolCallId,
        ),
      );
      const report = events.at(-1)?.payload;
      assert.ok(report?.kind === "task_report_snapshot");
      assert.equal(report.protocolRunState, "completed");
      assert.equal(report.report.verification.status, "unverified");
      assert.deepEqual(report.report.backgroundTasks, [
        { taskId: terminal.taskId, state: "succeeded" },
      ]);
      await delay(100);
      assert.equal(tasks(await log.read("fixture-session")).length, 3);
    }, "Start-Sleep -Milliseconds 700; Write-Output 'background-evidence'");
  });

  it("persists confirmed Session cleanup without treating the launch as completion", async () => {
    await fixture(async ({ runtime, log }) => {
      const result = await runtime.run("launch long synthetic task");
      assert.equal(result.status, "completed");
      const first = result.events.findLast(
        ({ payload }) => payload.kind === "task_report_snapshot",
      )?.payload;
      assert.ok(first?.kind === "task_report_snapshot");
      assert.equal(first.report.backgroundTasks[0]?.state, "running");
      await runtime.closeSession("stop-session");
      const events = await log.read("fixture-session");
      assert.deepEqual(
        tasks(events).map((task) => task.state),
        ["registered", "running", "cancelled"],
      );
      const report = events.at(-1)?.payload;
      assert.ok(report?.kind === "task_report_snapshot");
      assert.equal(report.protocolRunState, "completed");
      assert.equal(report.report.backgroundTasks[0]?.state, "cancelled");
    }, "Start-Sleep -Seconds 60");
  });
});
