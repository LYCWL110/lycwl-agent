export function assessRecovery(events) {
    const calls = new Map();
    const requested = new Set();
    const decided = new Map();
    const consumed = new Set();
    const revoked = new Set();
    let lastRunPayload = null;
    let expectedSeq = 1;
    let previousEventId = null;
    let previousHash = null;
    for (const event of events) {
        if (event.seq !== expectedSeq)
            return { ok: false, code: "sequence_invalid" };
        if (event.previousEventId !== previousEventId || event.previousHash !== previousHash) {
            return { ok: false, code: "chain_invalid" };
        }
        expectedSeq += 1;
        previousEventId = event.eventId;
        previousHash = event.hash;
        const payload = event.payload;
        switch (payload.kind) {
            case "tool_call_received":
                calls.set(payload.toolCallId, {
                    toolCallId: payload.toolCallId,
                    dispatched: false,
                    started: false,
                    terminal: null,
                });
                break;
            case "approval_requested":
                requested.add(payload.approvalId);
                break;
            case "approval_decided":
                decided.set(payload.approvalId, payload.decision);
                break;
            case "tool_dispatch_committed":
                ensureCall(calls, payload.toolCallId).dispatched = true;
                if (payload.approvalId !== null)
                    consumed.add(payload.approvalId);
                break;
            case "tool_execution_started":
                ensureCall(calls, payload.toolCallId).started = true;
                break;
            case "tool_execution_finished":
                ensureCall(calls, payload.toolCallId).terminal = payload.status;
                break;
            case "tool_execution_denied":
                ensureCall(calls, payload.toolCallId).terminal = "denied";
                break;
            case "tool_call_cancelled":
                ensureCall(calls, payload.toolCallId).terminal = "cancelled";
                break;
            case "approval_grant_revoked":
                revoked.add(payload.approvalId);
                break;
            case "run_completed":
            case "run_failed":
            case "run_cancelled":
            case "run_waiting":
                lastRunPayload = payload;
                break;
            default:
                break;
        }
    }
    const recovered = [];
    for (const call of calls.values()) {
        if (call.terminal !== null) {
            recovered.push({
                kind: "result_known",
                toolCallId: call.toolCallId,
                status: call.terminal,
                reuseResult: true,
            });
            continue;
        }
        if (!call.dispatched) {
            recovered.push({ kind: "not_started", toolCallId: call.toolCallId, mayReplan: true });
            continue;
        }
        // Dispatched with no terminal outcome: the side effect may already exist.
        recovered.push({
            kind: "outcome_unknown",
            toolCallId: call.toolCallId,
            requiresRecoveryReview: true,
        });
    }
    const grantsToRevoke = [...decided.entries()]
        .filter(([approvalId, decision]) => {
        return decision === "approved" && !consumed.has(approvalId) && !revoked.has(approvalId);
    })
        .map(([approvalId]) => approvalId)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const pendingApprovals = [...requested]
        .filter((approvalId) => !decided.has(approvalId))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const requiresRecoveryReview = recovered.some((call) => call.kind === "outcome_unknown" || call.kind === "not_started");
    return {
        ok: true,
        value: {
            calls: recovered,
            grantsToRevoke,
            pendingApprovals,
            requiresRecoveryReview,
            nextRunState: deriveNextRunState(lastRunPayload, requiresRecoveryReview),
        },
    };
}
function ensureCall(calls, toolCallId) {
    const existing = calls.get(toolCallId);
    if (existing !== undefined)
        return existing;
    const created = {
        toolCallId,
        dispatched: false,
        started: false,
        terminal: null,
    };
    calls.set(toolCallId, created);
    return created;
}
function deriveNextRunState(lastRunPayload, requiresRecoveryReview) {
    if (lastRunPayload === null)
        return requiresRecoveryReview ? "waiting" : "active";
    switch (lastRunPayload.kind) {
        case "run_completed":
            return requiresRecoveryReview ? "waiting" : "completed";
        case "run_failed":
            return "failed";
        case "run_cancelled":
            return "cancelled";
        case "run_waiting":
            return "waiting";
        default:
            return requiresRecoveryReview ? "waiting" : "active";
    }
}
/**
 * Classify the crash cut-point for one call from its recorded events. Used by
 * crash-injection tests and by a future recovery UI.
 */
export function classifyCrashCutPoint(events) {
    let dispatched = false;
    let started = false;
    let terminal = false;
    for (const event of events) {
        switch (event.payload.kind) {
            case "tool_dispatch_committed":
                dispatched = true;
                break;
            case "tool_execution_started":
                started = true;
                break;
            case "tool_execution_finished":
            case "tool_execution_denied":
            case "tool_call_cancelled":
                terminal = true;
                break;
            default:
                break;
        }
    }
    if (terminal)
        return "after_result";
    if (started)
        return "during_execution";
    if (dispatched)
        return "after_commit_before_start";
    return "before_dispatch_commit";
}
