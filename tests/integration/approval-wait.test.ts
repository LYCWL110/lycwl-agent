import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import {
  type PendingApprovalView,
  RuntimeCoordinator,
} from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "write_note",
  arguments: { text: "synthetic" },
} as const;

function coordinatorWith(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly (typeof CALL)[];
    text: string | null;
  }[],
  tools: RecordingTools,
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools,
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
    suspendOnApproval: true,
  });
  return { ids, digests, eventLog, coordinator };
}

async function waitForPending(coordinator: RuntimeCoordinator): Promise<PendingApprovalView> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const pending = coordinator.pendingApprovalView();
    if (pending !== null) return pending;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("approval wait never became pending");
}

describe("suspended approval wait", () => {
  it("waits, then executes on an approved reply without a second ResumeRun", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "executed" });
    const { coordinator, eventLog, digests } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      tools,
    );

    const running = coordinator.run("task needing approval");
    const pending = await waitForPending(coordinator);
    assert.equal(pending.toolName, CALL.toolName);
    assert.equal(tools.executions.length, 0);

    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "command-1",
        approvalId: pending.approvalId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        decision: "approved",
      }),
      { ok: true, duplicate: false },
    );

    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
    assert.equal(tools.executions.length, 1);
    assert.equal(coordinator.pendingApprovalView(), null);

    const waiting = result.events.filter(
      (event) => event.payload.kind === "run_waiting" && event.payload.reason === "approval",
    );
    assert.equal(waiting.length, 1);
    const requested = result.events.find((event) => event.payload.kind === "approval_requested");
    if (waiting[0]?.payload.kind !== "run_waiting") return;
    if (requested?.payload.kind !== "approval_requested") return;
    assert.equal(waiting[0].payload.waitToken, requested.payload.approvalId);
    assert.equal(waiting[0].payload.requestVersion, 1);

    const replayed = await replayRun(
      await eventLog.read(result.events[0]?.sessionId ?? ""),
      digests,
    );
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.value.state, "completed");
  });

  it("reports a denied approval as a denied tool result without executing", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "continued" },
      ],
      tools,
    );

    const running = coordinator.run("denied task");
    const pending = await waitForPending(coordinator);
    await coordinator.replyApproval({
      commandId: "deny-1",
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      decision: "denied",
    });
    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 0);
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
      false,
    );
    const denied = result.events.find((event) => event.payload.kind === "tool_execution_denied");
    assert.notEqual(denied, undefined);
  });

  it("rejects mismatched, stale and duplicate replies", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "executed" });
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      tools,
    );

    const running = coordinator.run("reply validation task");
    const pending = await waitForPending(coordinator);

    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "c1",
        approvalId: "wrong-approval",
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        decision: "approved",
      }),
      { ok: false, code: "unknown_approval" },
    );
    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "c2",
        approvalId: pending.approvalId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion + 1,
        decision: "approved",
      }),
      { ok: false, code: "stale_version" },
    );
    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "c3",
        approvalId: pending.approvalId,
        toolCallId: "wrong-call",
        requestVersion: pending.requestVersion,
        decision: "approved",
      }),
      { ok: false, code: "tool_call_mismatch" },
    );
    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "c4",
        approvalId: pending.approvalId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        decision: "approved",
      }),
      { ok: true, duplicate: false },
    );

    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 1);
  });

  it("treats a repeated command id as idempotent while the wait is still pending", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "executed" });
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      tools,
    );

    const running = coordinator.run("duplicate reply task");
    const pending = await waitForPending(coordinator);
    const first = await coordinator.replyApproval({
      commandId: "same-command",
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      decision: "approved",
    });
    assert.deepEqual(first, { ok: true, duplicate: false });
    await running;

    assert.equal(tools.executions.length, 1);
  });

  it("rejects a reply after the Run has ended", async () => {
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const { coordinator } = coordinatorWith(
      [{ kind: "completed", toolCalls: [], text: "done" }],
      tools,
    );

    await coordinator.run("no approval task");

    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "late",
        approvalId: "approval-x",
        toolCallId: "call-x",
        requestVersion: 1,
        decision: "approved",
      }),
      { ok: false, code: "run_terminal" },
    );
  });

  it("rejects an empty command id", async () => {
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const { coordinator } = coordinatorWith(
      [{ kind: "completed", toolCalls: [], text: "done" }],
      tools,
    );

    assert.deepEqual(
      await coordinator.replyApproval({
        commandId: "",
        approvalId: "approval-x",
        toolCallId: "call-x",
        requestVersion: 1,
        decision: "approved",
      }),
      { ok: false, code: "invalid_identity" },
    );
  });
});
