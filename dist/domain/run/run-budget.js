export const RUN_BUDGET_LIMITS = Object.freeze({
    modelRounds: 32,
    requestAttemptsPerLogicalRequest: 3,
    transientRetriesPerLogicalRequest: 2,
    overflowRecoveriesPerLogicalRequest: 1,
    compactions: 4,
    auxiliaryAttemptsPerCompaction: 2,
    elapsedActiveMs: 30 * 60 * 1000,
    testFixCycles: 3,
    siblingToolConcurrency: 1,
});
export function createRunBudget() {
    return {
        modelRounds: 0,
        compactions: 0,
        elapsedActiveMs: 0,
        testFixCycles: 0,
        knownSpendingUsd: 0,
    };
}
function validDelta(value) {
    return Number.isFinite(value) && value >= 0;
}
export function addModelRound(budget) {
    if (budget.modelRounds >= RUN_BUDGET_LIMITS.modelRounds) {
        return { ok: false, code: "round_limit" };
    }
    return { ok: true, value: { ...budget, modelRounds: budget.modelRounds + 1 } };
}
export function addCompaction(budget) {
    if (budget.compactions >= RUN_BUDGET_LIMITS.compactions) {
        return { ok: false, code: "compaction_limit" };
    }
    return { ok: true, value: { ...budget, compactions: budget.compactions + 1 } };
}
export function addActiveTime(budget, elapsedMs) {
    if (!validDelta(elapsedMs)) {
        return { ok: false, code: "invalid_delta" };
    }
    const next = budget.elapsedActiveMs + elapsedMs;
    if (next > RUN_BUDGET_LIMITS.elapsedActiveMs) {
        return { ok: false, code: "elapsed_limit" };
    }
    return { ok: true, value: { ...budget, elapsedActiveMs: next } };
}
export function addTestFixCycle(budget) {
    if (budget.testFixCycles >= RUN_BUDGET_LIMITS.testFixCycles) {
        return { ok: false, code: "test_fix_limit" };
    }
    return { ok: true, value: { ...budget, testFixCycles: budget.testFixCycles + 1 } };
}
