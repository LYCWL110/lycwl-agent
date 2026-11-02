export const APPROVAL_STATES = [
  "pending",
  "approved",
  "denied",
  "invalidated",
  "cancelled",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export type Approval = Readonly<{
  approvalId: string;
  toolCallId: string;
  state: ApprovalState;
}>;

export type ApprovalTransition =
  | Readonly<{ ok: true; value: Approval }>
  | Readonly<{
      ok: false;
      code: "invalid_identity" | "invalid_transition" | "terminal_decision_immutable";
    }>;

const TERMINAL_STATES: ReadonlySet<ApprovalState> = new Set([
  "approved",
  "denied",
  "invalidated",
  "cancelled",
]);

export function requestApproval(approvalId: string, toolCallId: string): ApprovalTransition {
  if (approvalId.length === 0 || toolCallId.length === 0) {
    return { ok: false, code: "invalid_identity" };
  }
  return {
    ok: true,
    value: { approvalId, toolCallId, state: "pending" },
  };
}

export function decideApproval(
  approval: Approval,
  state: Exclude<ApprovalState, "pending">,
): ApprovalTransition {
  if (TERMINAL_STATES.has(approval.state)) {
    return { ok: false, code: "terminal_decision_immutable" };
  }
  return {
    ok: true,
    value: { ...approval, state },
  };
}

export type ApprovalGrant = Readonly<{
  approvalId: string;
  state: "available" | "consumed" | "revoked";
}>;

export function consumeApprovalGrant(
  grant: ApprovalGrant,
): Readonly<{ ok: true; value: ApprovalGrant }> | Readonly<{ ok: false; code: "grant_unavailable" }> {
  if (grant.state !== "available") {
    return { ok: false, code: "grant_unavailable" };
  }
  return { ok: true, value: { ...grant, state: "consumed" } };
}

export function revokeApprovalGrant(
  grant: ApprovalGrant,
): Readonly<{ ok: true; value: ApprovalGrant }> | Readonly<{ ok: false; code: "grant_unavailable" }> {
  if (grant.state !== "available") {
    return { ok: false, code: "grant_unavailable" };
  }
  return { ok: true, value: { ...grant, state: "revoked" } };
}
