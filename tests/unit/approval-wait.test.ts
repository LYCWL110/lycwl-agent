import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ApprovalWait,
  emptyApprovalWaitRegistry,
  grantsToRevokeOnRestart,
  resolveApprovalReply,
} from "../../src/domain/approval/approval-wait.ts";

const WAIT: ApprovalWait = {
  approvalId: "approval-1",
  toolCallId: "call-1",
  waitToken: "wait-1",
  requestVersion: 1,
};

function reply(overrides: Partial<Parameters<typeof resolveApprovalReply>[2]> = {}) {
  return {
    commandId: "command-1",
    approvalId: "approval-1",
    toolCallId: "call-1",
    requestVersion: 1,
    decision: "approved" as const,
    ...overrides,
  };
}

describe("approval wait resolution", () => {
  it("resolves a matching reply and records the command id", () => {
    const result = resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.decision, "approved");
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.registry.handledCommandIds, { "command-1": "approved" });
  });

  it("treats a repeated command id as idempotent, not a second consumption", () => {
    const first = resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = resolveApprovalReply(WAIT, first.registry, reply());
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.duplicate, true);
    assert.equal(second.decision, "approved");
    assert.deepEqual(second.registry, first.registry);
  });

  it("rejects the same command id replayed with a different decision", () => {
    const first = resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(resolveApprovalReply(WAIT, first.registry, reply({ decision: "denied" })), {
      ok: false,
      code: "conflicting_reply",
    });
  });

  it("rejects a reply for a different approval or tool call", () => {
    assert.deepEqual(
      resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply({ approvalId: "approval-2" })),
      { ok: false, code: "unknown_approval" },
    );
    assert.deepEqual(
      resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply({ toolCallId: "call-2" })),
      { ok: false, code: "tool_call_mismatch" },
    );
    assert.deepEqual(resolveApprovalReply(null, emptyApprovalWaitRegistry(), reply()), {
      ok: false,
      code: "unknown_approval",
    });
  });

  it("rejects a stale wait version", () => {
    assert.deepEqual(
      resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply({ requestVersion: 2 })),
      { ok: false, code: "stale_version" },
    );
  });

  it("rejects empty identities", () => {
    assert.deepEqual(
      resolveApprovalReply(WAIT, emptyApprovalWaitRegistry(), reply({ commandId: "" })),
      { ok: false, code: "invalid_identity" },
    );
  });
});

describe("restart grant revocation", () => {
  it("revokes only available grants", () => {
    assert.deepEqual(
      grantsToRevokeOnRestart({
        "approval-b": "available",
        "approval-a": "available",
        "approval-c": "consumed",
        "approval-d": "revoked",
      }),
      ["approval-a", "approval-b"],
    );
  });
});
