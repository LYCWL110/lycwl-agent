export const MODEL_REQUEST_STATES = ["in_flight", "succeeded", "failed", "cancelled"];
const TERMINAL_STATES = new Set([
    "succeeded",
    "failed",
    "cancelled",
]);
export function beginModelRequest(modelRequestId, attemptNo) {
    if (modelRequestId.length === 0 || !Number.isSafeInteger(attemptNo) || attemptNo < 1) {
        return { ok: false, code: "invalid_request_identity" };
    }
    return {
        ok: true,
        value: { modelRequestId, attemptNo, state: "in_flight" },
    };
}
export function finishModelRequest(request, state) {
    if (TERMINAL_STATES.has(request.state)) {
        return { ok: false, code: "invalid_transition" };
    }
    return {
        ok: true,
        value: { ...request, state },
    };
}
