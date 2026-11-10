import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commitToolDispatch,
  consumeApprovalGrant,
  decideApproval,
  requestApproval,
  revokeApprovalGrant,
} from "../../src/domain/approval/approval-state.ts";

describe("approval state machine", () => {
  it("makes decisions immutable", () => {
    const pending = requestApproval("approval-1", "call-1");
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const approved = decideApproval(pending.value, "approved");
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.deepEqual(decideApproval(approved.value, "denied"), {
      ok: false,
      code: "terminal_decision_immutable",
    });
  });

  it("consumes or revokes a grant only once", () => {
    const grant = { approvalId: "approval-1", state: "available" } as const;
    const consumed = consumeApprovalGrant(grant);
    assert.equal(consumed.ok, true);
    if (!consumed.ok) return;
    assert.deepEqual(revokeApprovalGrant(consumed.value), {
      ok: false,
      code: "grant_unavailable",
    });
  });

  it("consumes an available grant only through a matching dispatch commit", () => {
    const grant = { approvalId: "approval-1", state: "available" } as const;
    const mismatch = commitToolDispatch(grant, {
      dispatchId: "dispatch-1",
      toolCallId: "call-1",
      approvalId: "approval-2",
    });
    assert.deepEqual(mismatch, { ok: false, code: "grant_mismatch" });

    const committed = commitToolDispatch(grant, {
      dispatchId: "dispatch-1",
      toolCallId: "call-1",
      approvalId: "approval-1",
    });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    assert.equal(committed.grant?.state, "consumed");
    assert.deepEqual(
      commitToolDispatch(committed.grant, {
        dispatchId: "dispatch-2",
        toolCallId: "call-1",
        approvalId: "approval-1",
      }),
      { ok: false, code: "grant_unavailable" },
    );
  });
});
