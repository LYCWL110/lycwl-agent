import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addActiveTime,
  addKnownSpending,
  addModelRound,
  createRunBudget,
  RUN_BUDGET_LIMITS,
} from "../../src/domain/run/run-budget.ts";

describe("Run budgets", () => {
  it("stops before exceeding the model-round limit", () => {
    let budget = createRunBudget();
    for (let i = 0; i < RUN_BUDGET_LIMITS.modelRounds; i += 1) {
      const result = addModelRound(budget);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      budget = result.value;
    }
    assert.deepEqual(addModelRound(budget), { ok: false, code: "round_limit" });
  });

  it("pauses accounting outside active time and retains elapsed totals", () => {
    const first = addActiveTime(createRunBudget(), 1_000);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = addActiveTime(first.value, 2_000);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.elapsedActiveMs, 3_000);
  });

  it("treats the spending threshold as a stop-new-requests boundary", () => {
    const result = addKnownSpending(createRunBudget(), 5);
    assert.deepEqual(result, { ok: false, code: "spending_limit" });
  });
});
