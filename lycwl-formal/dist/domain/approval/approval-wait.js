export function emptyApprovalWaitRegistry() {
    return { handledCommandIds: {} };
}
export function resolveApprovalReply(wait, registry, reply) {
    if (reply.commandId.length === 0 ||
        reply.approvalId.length === 0 ||
        reply.toolCallId.length === 0) {
        return { ok: false, code: "invalid_identity" };
    }
    const alreadyHandled = registry.handledCommandIds[reply.commandId];
    if (alreadyHandled !== undefined) {
        return alreadyHandled === reply.decision
            ? { ok: true, decision: alreadyHandled, duplicate: true, registry }
            : { ok: false, code: "conflicting_reply" };
    }
    if (wait === null)
        return { ok: false, code: "unknown_approval" };
    if (wait.approvalId !== reply.approvalId)
        return { ok: false, code: "unknown_approval" };
    if (wait.toolCallId !== reply.toolCallId)
        return { ok: false, code: "tool_call_mismatch" };
    if (wait.requestVersion !== reply.requestVersion) {
        return { ok: false, code: "stale_version" };
    }
    return {
        ok: true,
        decision: reply.decision,
        duplicate: false,
        registry: {
            handledCommandIds: {
                ...registry.handledCommandIds,
                [reply.commandId]: reply.decision,
            },
        },
    };
}
/**
 * After a restart an approved but unused grant must be revoked and reapproved.
 * The original decision stays immutable; only the derived grant changes.
 */
export function grantsToRevokeOnRestart(grants) {
    return Object.entries(grants)
        .filter(([, state]) => state === "available")
        .map(([approvalId]) => approvalId)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
