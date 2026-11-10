export function projectApprovalGrants(events) {
    const requested = new Set();
    const grants = {};
    for (const event of events) {
        const payload = event.payload;
        switch (payload.kind) {
            case "approval_requested":
                requested.add(payload.approvalId);
                break;
            case "approval_decided": {
                if (!requested.has(payload.approvalId)) {
                    return { ok: false, code: "decision_without_request" };
                }
                if (payload.decision === "approved")
                    grants[payload.approvalId] = "available";
                break;
            }
            case "tool_dispatch_committed": {
                if (payload.approvalId === null)
                    break;
                const state = grants[payload.approvalId];
                if (state === "consumed")
                    return { ok: false, code: "grant_already_consumed" };
                if (state !== "available")
                    return { ok: false, code: "dispatch_without_grant" };
                grants[payload.approvalId] = "consumed";
                break;
            }
            case "approval_grant_revoked": {
                if (grants[payload.approvalId] !== "available") {
                    return { ok: false, code: "revoke_without_grant" };
                }
                grants[payload.approvalId] = "revoked";
                break;
            }
            default:
                break;
        }
    }
    return { ok: true, grants };
}
