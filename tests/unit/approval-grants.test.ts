import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectApprovalGrants } from "../../src/application/coordinator/approval-grants.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import type { InternalEvent } from "../../src/application/coordinator/internal-events.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

async function build(
  append: (log: InMemoryEventLog) => Promise<void>,
): Promise<readonly InternalEvent[]> {
  const log = new InMemoryEventLog(new SequenceIds("grants"), new JsonDigest());
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_started",
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:00.000Z",
    payload: { kind: "run_started", input: "synthetic task" },
  });
  await append(log);
  return log.read("session-1");
}

function record(
  type: InternalEvent["type"],
  payload: InternalEvent["payload"],
): Parameters<InMemoryEventLog["append"]>[0] {
  return {
    sessionId: "session-1",
    runId: "run-1",
    type,
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:01.000Z",
    payload,
  };
}

describe("event-derived approval grants", () => {
  it("derives an available grant from an approved decision", async () => {
    const events = await build(async (log) => {
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
          decision: "approved",
        }),
      );
    });

    const projection = projectApprovalGrants(events);
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    assert.deepEqual(projection.grants, { "approval-1": "available" });
  });

  it("consumes the grant at the durable dispatch commit", async () => {
    const events = await build(async (log) => {
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
          decision: "approved",
        }),
      );
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-1",
          approvalId: "approval-1",
        }),
      );
    });

    const projection = projectApprovalGrants(events);
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    assert.deepEqual(projection.grants, { "approval-1": "consumed" });
  });

  it("refuses a second dispatch on an already consumed grant", async () => {
    const events = await build(async (log) => {
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
          decision: "approved",
        }),
      );
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-1",
          approvalId: "approval-1",
        }),
      );
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-2",
          toolCallId: "call-1",
          approvalId: "approval-1",
        }),
      );
    });

    assert.deepEqual(projectApprovalGrants(events), {
      ok: false,
      code: "grant_already_consumed",
    });
  });

  it("refuses a dispatch that has no approved grant", async () => {
    const events = await build(async (log) => {
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
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-1",
          approvalId: "approval-1",
        }),
      );
    });

    assert.deepEqual(projectApprovalGrants(events), {
      ok: false,
      code: "dispatch_without_grant",
    });
  });

  it("revokes an unused grant without rewriting the approval decision", async () => {
    const events = await build(async (log) => {
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
          decision: "approved",
        }),
      );
      await log.append(
        record("approval_grant_revoked", {
          kind: "approval_grant_revoked",
          approvalId: "approval-1",
          toolCallId: "call-1",
          reason: "restart",
        }),
      );
    });

    const projection = projectApprovalGrants(events);
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    assert.deepEqual(projection.grants, { "approval-1": "revoked" });
    const decision = events.find((event) => event.payload.kind === "approval_decided");
    assert.equal(decision?.payload.kind, "approval_decided");
    if (decision?.payload.kind !== "approval_decided") return;
    assert.equal(decision.payload.decision, "approved");
  });

  it("ignores a denied approval and a grant-free dispatch", async () => {
    const events = await build(async (log) => {
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
          decision: "denied",
        }),
      );
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-2",
          approvalId: null,
        }),
      );
    });

    const projection = projectApprovalGrants(events);
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    assert.deepEqual(projection.grants, {});
  });
});
