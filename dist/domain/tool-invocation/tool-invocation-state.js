export const TOOL_INVOCATION_STATES = [
    "received",
    "validated",
    "awaiting_approval",
    "ready",
    "executing",
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "outcome_unknown",
];
const TERMINAL_STATES = new Set([
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "outcome_unknown",
]);
const NEXT_STATES = {
    received: ["validated", "failed", "cancelled"],
    validated: ["awaiting_approval", "ready", "failed", "cancelled"],
    awaiting_approval: ["ready", "denied", "cancelled"],
    ready: ["executing", "failed", "cancelled"],
    executing: ["succeeded", "failed", "cancelled", "outcome_unknown"],
    succeeded: [],
    failed: [],
    denied: [],
    cancelled: [],
    outcome_unknown: [],
};
export function receiveToolInvocation(toolCallId) {
    if (toolCallId.length === 0) {
        return { ok: false, code: "invalid_identity" };
    }
    return { ok: true, value: { toolCallId, state: "received" } };
}
export function transitionToolInvocation(invocation, next) {
    if (TERMINAL_STATES.has(invocation.state)) {
        return { ok: false, code: "terminal_outcome_immutable" };
    }
    if (!NEXT_STATES[invocation.state].includes(next)) {
        return { ok: false, code: "invalid_transition" };
    }
    return { ok: true, value: { ...invocation, state: next } };
}
