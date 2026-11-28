export const APPROVAL_STATES = [
    "pending",
    "approved",
    "denied",
    "invalidated",
    "cancelled",
];
const TERMINAL_STATES = new Set([
    "approved",
    "denied",
    "invalidated",
    "cancelled",
]);
export function requestApproval(approvalId, toolCallId) {
    if (approvalId.length === 0 || toolCallId.length === 0) {
        return { ok: false, code: "invalid_identity" };
    }
    return {
        ok: true,
        value: { approvalId, toolCallId, state: "pending" },
    };
}
export function decideApproval(approval, state) {
    if (TERMINAL_STATES.has(approval.state)) {
        return { ok: false, code: "terminal_decision_immutable" };
    }
    return {
        ok: true,
        value: { ...approval, state },
    };
}
export function commitToolDispatch(grant, commit) {
    if (commit.dispatchId.length === 0 ||
        commit.toolCallId.length === 0 ||
        (commit.approvalId !== null && commit.approvalId.length === 0)) {
        return { ok: false, code: "invalid_identity" };
    }
    if (grant === null) {
        return commit.approvalId === null
            ? { ok: true, grant: null }
            : { ok: false, code: "grant_required" };
    }
    if (commit.approvalId === null)
        return { ok: false, code: "grant_mismatch" };
    if (grant.approvalId !== commit.approvalId)
        return { ok: false, code: "grant_mismatch" };
    const consumed = consumeApprovalGrant(grant);
    if (!consumed.ok)
        return { ok: false, code: consumed.code };
    return { ok: true, grant: consumed.value };
}
export function consumeApprovalGrant(grant) {
    if (grant.state !== "available") {
        return { ok: false, code: "grant_unavailable" };
    }
    return { ok: true, value: { ...grant, state: "consumed" } };
}
export function revokeApprovalGrant(grant) {
    if (grant.state !== "available") {
        return { ok: false, code: "grant_unavailable" };
    }
    return { ok: true, value: { ...grant, state: "revoked" } };
}
