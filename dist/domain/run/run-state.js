export const RUN_STATES = ["active", "waiting", "completed", "failed", "cancelled"];
export const WAITING_REASONS = [
    "approval",
    "user_input",
    "configuration",
    "external_dependency",
    "recovery_review",
];
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
export function isTerminalRun(run) {
    return TERMINAL_STATES.has(run.state);
}
export function startRun() {
    return { state: "active" };
}
export function waitRun(run, reason, waitToken, requestVersion) {
    if (isTerminalRun(run)) {
        return { ok: false, code: "run_terminal" };
    }
    if (waitToken.length === 0 || !Number.isSafeInteger(requestVersion) || requestVersion < 1) {
        return { ok: false, code: "invalid_wait" };
    }
    return {
        ok: true,
        value: { state: "waiting", reason, waitToken, requestVersion },
    };
}
export function resumeRun(run) {
    if (isTerminalRun(run)) {
        return { ok: false, code: "run_terminal" };
    }
    if (run.state !== "waiting") {
        return { ok: false, code: "invalid_transition" };
    }
    return { ok: true, value: { state: "active" } };
}
export function finishRun(run, terminal) {
    if (isTerminalRun(run)) {
        return { ok: false, code: "run_terminal" };
    }
    return { ok: true, value: { state: terminal } };
}
export function resolveRunWait(run, expected) {
    if (isTerminalRun(run)) {
        return { ok: false, code: "run_terminal" };
    }
    if (run.state !== "waiting" ||
        run.waitToken !== expected.waitToken ||
        run.requestVersion !== expected.requestVersion ||
        run.reason !== expected.reason) {
        return { ok: false, code: "wait_not_resolvable" };
    }
    return { ok: true, value: { state: "active" } };
}
