export function compareCancellation(boundary) {
    const { cancelSeq, dispatchSeq } = boundary;
    if (!Number.isSafeInteger(cancelSeq) ||
        !Number.isSafeInteger(dispatchSeq) ||
        cancelSeq < 1 ||
        dispatchSeq < 1) {
        return { ok: false, code: "invalid_sequence" };
    }
    return {
        ok: true,
        outcome: cancelSeq < dispatchSeq ? "dispatch_prevented" : "dispatch_already_committed",
    };
}
export function projectCancelledCall(call) {
    switch (call.sideEffect) {
        case "not_started":
            return { toolCallId: call.toolCallId, outcome: "cancelled", safeCode: null };
        case "in_flight":
        case "unknown":
            return {
                toolCallId: call.toolCallId,
                outcome: "cancelled_outcome_unknown",
                safeCode: "cancelled_during_execution",
            };
        case "completed":
            return {
                toolCallId: call.toolCallId,
                outcome: "completed_before_cancel",
                safeCode: null,
            };
    }
}
