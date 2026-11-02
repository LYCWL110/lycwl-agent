import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
});
