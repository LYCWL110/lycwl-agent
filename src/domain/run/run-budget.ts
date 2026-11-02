export const RUN_BUDGET_LIMITS = Object.freeze({
  modelRounds: 32,
  requestAttemptsPerLogicalRequest: 3,
  transientRetriesPerLogicalRequest: 2,
  overflowRecoveriesPerLogicalRequest: 1,
  compactions: 4,
  auxiliaryAttemptsPerCompaction: 2,
  elapsedActiveMs: 30 * 60 * 1000,
  testFixCycles: 3,
  knownPriceSpendingUsd: 5,
  siblingToolConcurrency: 1,
} as const);

export type RunBudget = Readonly<{
  modelRounds: number;
  compactions: number;
  elapsedActiveMs: number;
  testFixCycles: number;
  knownSpendingUsd: number;
}>;

export function createRunBudget(): RunBudget {
  return {
    modelRounds: 0,
    compactions: 0,
    elapsedActiveMs: 0,
    testFixCycles: 0,
    knownSpendingUsd: 0,
  };
}

export type BudgetFailure =
  | "round_limit"
  | "compaction_limit"
  | "elapsed_limit"
  | "test_fix_limit"
  | "spending_limit"
  | "invalid_delta";

export type BudgetResult =
  | Readonly<{ ok: true; value: RunBudget }>
  | Readonly<{ ok: false; code: BudgetFailure }>;

function validDelta(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function addModelRound(budget: RunBudget): BudgetResult {
  if (budget.modelRounds >= RUN_BUDGET_LIMITS.modelRounds) {
    return { ok: false, code: "round_limit" };
  }
  return { ok: true, value: { ...budget, modelRounds: budget.modelRounds + 1 } };
}

export function addCompaction(budget: RunBudget): BudgetResult {
  if (budget.compactions >= RUN_BUDGET_LIMITS.compactions) {
    return { ok: false, code: "compaction_limit" };
  }
  return { ok: true, value: { ...budget, compactions: budget.compactions + 1 } };
}

export function addActiveTime(budget: RunBudget, elapsedMs: number): BudgetResult {
  if (!validDelta(elapsedMs)) {
    return { ok: false, code: "invalid_delta" };
  }
  const next = budget.elapsedActiveMs + elapsedMs;
  if (next > RUN_BUDGET_LIMITS.elapsedActiveMs) {
    return { ok: false, code: "elapsed_limit" };
  }
  return { ok: true, value: { ...budget, elapsedActiveMs: next } };
}

export function addTestFixCycle(budget: RunBudget): BudgetResult {
  if (budget.testFixCycles >= RUN_BUDGET_LIMITS.testFixCycles) {
    return { ok: false, code: "test_fix_limit" };
  }
  return { ok: true, value: { ...budget, testFixCycles: budget.testFixCycles + 1 } };
}

export function addKnownSpending(budget: RunBudget, amountUsd: number): BudgetResult {
  if (!validDelta(amountUsd)) {
    return { ok: false, code: "invalid_delta" };
  }
  const next = budget.knownSpendingUsd + amountUsd;
  if (next >= RUN_BUDGET_LIMITS.knownPriceSpendingUsd) {
    return { ok: false, code: "spending_limit" };
  }
  return { ok: true, value: { ...budget, knownSpendingUsd: next } };
}
