import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { injectCrashAt } from "../../src/adapters/persistence/crash-injection.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { assessRecovery, classifyCrashCutPoint } from "../../src/domain/persistence/recovery.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

type Append = Parameters<InMemoryEventLog["append"]>[0];

function record(type: InternalEvent["type"], payload: InternalEvent["payload"]): Append {
  return {
    sessionId: "session-1",
    runId: "run-1",
    type,
    correlationId: "c",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:01.000Z",
    payload,
  };
}

async function scenario(options: {
  approved?: boolean;
  dispatched?: boolean;
  started?: boolean;
  finished?: string;
  extra?: readonly Append[];
}): Promise<readonly InternalEvent[]> {
  const log = new InMemoryEventLog(new SequenceIds("crash"), new JsonDigest());
  await log.append(record("run_started", { kind: "run_started", input: "task" }));
  await log.append(
    record("tool_call_received", {
      kind: "tool_call_received",
      toolCallId: "call-1",
      providerToolCallId: "provider-1",
      toolName: "write_note",
      arguments: {},
    }),
  );
  if (options.approved !== undefined) {
    await log.append(
      record("approval_requested", {
        kind: "approval_requested",
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "write_note",
        safePreview: "write_note preview",
      }),
    );
    await log.append(
      record("approval_decided", {
        kind: "approval_decided",
        approvalId: "approval-1",
        toolCallId: "call-1",
        decision: options.approved ? "approved" : "denied",
      }),
    );
  }
  if (options.dispatched === true) {
    await log.append(
      record("tool_dispatch_committed", {
        kind: "tool_dispatch_committed",
        dispatchId: "dispatch-1",
        toolCallId: "call-1",
        approvalId: options.approved === true ? "approval-1" : null,
      }),
    );
  }
  if (options.started === true) {
    await log.append(
      record("tool_execution_started", {
        kind: "tool_execution_started",
        toolCallId: "call-1",
        toolName: "write_note",
      }),
    );
  }
  if (options.finished !== undefined) {
    await log.append(
      record("tool_execution_finished", {
        kind: "tool_execution_finished",
        toolCallId: "call-1",
        status: options.finished as "succeeded" | "failed" | "outcome_unknown",
        safeCode: null,
        text: null,
      }),
    );
  }
  for (const event of options.extra ?? []) await log.append(event);
  return log.read("session-1");
}

function call(events: readonly InternalEvent[], toolCallId = "call-1") {
  const result = assessRecovery(events);
  if (!result.ok) throw new Error(result.code);
  return result.value.calls.find((entry) => entry.toolCallId === toolCallId);
}

describe("crash cut-point classification", () => {
  it("classifies each of the four cut-points", async () => {
    assert.equal(classifyCrashCutPoint(await scenario({})), "before_dispatch_commit");
    assert.equal(
      classifyCrashCutPoint(await scenario({ dispatched: true })),
      "after_commit_before_start",
    );
    assert.equal(
      classifyCrashCutPoint(await scenario({ dispatched: true, started: true })),
      "during_execution",
    );
    assert.equal(
      classifyCrashCutPoint(
        await scenario({ dispatched: true, started: true, finished: "succeeded" }),
      ),
      "after_result",
    );
  });
});

describe("recovery assessment at each cut-point", () => {
  it("treats an undispatched call as not started and replannable", async () => {
    const events = await scenario({ approved: true });
    const entry = call(events);
    assert.deepEqual(entry, { kind: "not_started", toolCallId: "call-1", mayReplan: true });
  });

  it("treats a committed-but-unstarted call as outcome_unknown", async () => {
    const events = await scenario({ dispatched: true });
    const entry = call(events);
    assert.deepEqual(entry, {
      kind: "outcome_unknown",
      toolCallId: "call-1",
      requiresRecoveryReview: true,
    });
  });

  it("treats a crash during execution as outcome_unknown", async () => {
    const events = await scenario({ dispatched: true, started: true });
    const entry = call(events);
    assert.equal(entry?.kind, "outcome_unknown");
  });

  it("reuses a recorded result without re-executing", async () => {
    const events = await scenario({
      dispatched: true,
      started: true,
      finished: "succeeded",
    });
    const entry = call(events);
    assert.deepEqual(entry, {
      kind: "result_known",
      toolCallId: "call-1",
      status: "succeeded",
      reuseResult: true,
    });
  });

  it("revokes an approved but unconsumed grant", async () => {
    const events = await scenario({ approved: true });
    const result = assessRecovery(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.grantsToRevoke, ["approval-1"]);
  });

  it("does not revoke a grant that was consumed by dispatch", async () => {
    const events = await scenario({ approved: true, dispatched: true });
    const result = assessRecovery(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.grantsToRevoke, []);
  });

  it("keeps a pending approval pending rather than auto-deciding", async () => {
    const log = new InMemoryEventLog(new SequenceIds("crash"), new JsonDigest());
    await log.append(record("run_started", { kind: "run_started", input: "task" }));
    await log.append(
      record("approval_requested", {
        kind: "approval_requested",
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "write_note",
        safePreview: "write_note preview",
      }),
    );
    const result = assessRecovery(await log.read("session-1"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.pendingApprovals, ["approval-1"]);
    assert.deepEqual(result.value.grantsToRevoke, []);
  });

  it("requires recovery review whenever a call is unknown or unstarted", async () => {
    const committed = assessRecovery(await scenario({ dispatched: true }));
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    assert.equal(committed.value.requiresRecoveryReview, true);
    assert.equal(committed.value.nextRunState, "waiting");

    const clean = assessRecovery(
      await scenario({ dispatched: true, started: true, finished: "succeeded" }),
    );
    assert.equal(clean.ok, true);
    if (!clean.ok) return;
    assert.equal(clean.value.requiresRecoveryReview, false);
  });

  it("rejects a broken sequence or chain", async () => {
    const events = await scenario({ dispatched: true });
    const tampered = events.map((event, index) => (index === 2 ? { ...event, seq: 99 } : event));
    assert.deepEqual(assessRecovery(tampered), { ok: false, code: "sequence_invalid" });

    const broken = events.map((event, index) =>
      index === 2 ? { ...event, previousHash: "wrong" } : event,
    );
    assert.deepEqual(assessRecovery(broken), { ok: false, code: "chain_invalid" });
  });
});

describe("crash injection helper", () => {
  it("truncates at each cut-point and reports what was lost", async () => {
    const events = await scenario({
      dispatched: true,
      started: true,
      finished: "succeeded",
    });

    const beforeCommit = injectCrashAt(events, "before_dispatch_commit");
    assert.equal(
      beforeCommit.surviving.some((event) => event.payload.kind === "tool_dispatch_committed"),
      false,
    );
    assert.equal(beforeCommit.lost.includes("tool_dispatch_committed"), true);

    const afterCommit = injectCrashAt(events, "after_commit_before_start");
    assert.equal(afterCommit.surviving.at(-1)?.payload.kind, "tool_dispatch_committed");

    const duringExecution = injectCrashAt(events, "during_execution");
    assert.equal(duringExecution.surviving.at(-1)?.payload.kind, "tool_execution_started");

    const afterResult = injectCrashAt(events, "after_result");
    assert.equal(afterResult.surviving.at(-1)?.payload.kind, "tool_execution_finished");
    assert.deepEqual(afterResult.lost, []);
  });

  it("recovers the truncated prefix consistently with the cut-point", async () => {
    const events = await scenario({
      dispatched: true,
      started: true,
      finished: "succeeded",
    });

    const afterCommit = injectCrashAt(events, "after_commit_before_start");
    assert.equal(call(afterCommit.surviving)?.kind, "outcome_unknown");

    const afterResult = injectCrashAt(events, "after_result");
    assert.equal(call(afterResult.surviving)?.kind, "result_known");

    const beforeCommit = injectCrashAt(events, "before_dispatch_commit");
    assert.equal(call(beforeCommit.surviving)?.kind, "not_started");
  });
});
