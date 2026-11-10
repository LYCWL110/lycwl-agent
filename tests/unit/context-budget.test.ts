import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTEXT_LIMITS,
  computeContextBudget,
  conservativeEstimate,
  decideRequestFit,
} from "../../src/domain/context/context-budget.ts";

describe("C04 budget arithmetic", () => {
  it("reproduces the documented W=8192 example", () => {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 3000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The contract states these exact values for this input.
    assert.equal(result.value.output, 1638);
    assert.equal(result.value.gap, 512);
    assert.equal(result.value.promptBudget, 6042);
    assert.equal(result.value.historyBudget, 3042);
    assert.equal(result.value.recentBudget, 1826);
    assert.equal(result.value.summaryBudget, 1216);
  });

  it("fails when the fixed part leaves too little history", () => {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 5400,
    });
    // The contract states F=5400 gives H=642 and must fail.
    assert.deepEqual(result, { ok: false, code: "context_capacity_insufficient" });
  });

  it("returns model_context_unknown for an unknown window", () => {
    const result = computeContextBudget({
      window: null,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 1000,
    });
    assert.deepEqual(result, { ok: false, code: "model_context_unknown" });
  });

  it("rejects a window below the supported minimum", () => {
    const result = computeContextBudget({
      window: CONTEXT_LIMITS.minWindow - 1,
      modelMaxOutput: 4096,
      userMaxOutput: 2048,
      fixed: 100,
    });
    assert.deepEqual(result, { ok: false, code: "context_window_too_small" });
  });

  it("caps output at the smaller of user, model and the 20% fraction", () => {
    const user = computeContextBudget({
      window: 100_000,
      modelMaxOutput: 100_000,
      userMaxOutput: 1000,
      fixed: 1000,
    });
    assert.equal(user.ok, true);
    if (!user.ok) return;
    // max(1024, 20000) = 20000, but the user capped it at 1000.
    assert.equal(user.value.output, 1000);

    const model = computeContextBudget({
      window: 100_000,
      modelMaxOutput: 2000,
      userMaxOutput: 50_000,
      fixed: 1000,
    });
    assert.equal(model.ok, true);
    if (!model.ok) return;
    assert.equal(model.value.output, 2000);
  });

  it("takes the minimum of user, model and the 20% floor, so a tiny limit wins", () => {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 10,
      userMaxOutput: 10,
      fixed: 1000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // O = min(user, model, max(1024, 0.2W)): the minimum is the outer operation,
    // so a provider cap of 10 is respected rather than raised to the floor.
    assert.equal(result.value.output, 10);
  });

  it("labels every estimate and carries the conservative factor", () => {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 3000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.estimated, true);
    assert.equal(result.conservativeFactor, 1.2);
  });

  it("sets the compaction trigger at 80% of P", () => {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 3000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.compactionTrigger, Math.floor(0.8 * 6042));
  });
});

describe("conservative estimation", () => {
  it("multiplies by the factor and rounds up", () => {
    assert.equal(conservativeEstimate(100), 120);
    assert.equal(conservativeEstimate(101), 122);
    assert.equal(conservativeEstimate(0), 0);
  });

  it("treats a non-finite estimate as infinite rather than zero", () => {
    assert.equal(conservativeEstimate(Number.NaN), Number.POSITIVE_INFINITY);
    assert.equal(conservativeEstimate(-1), Number.POSITIVE_INFINITY);
  });
});

describe("request fit decisions", () => {
  function budget() {
    const result = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 3000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("budget");
    return result.value;
  }

  it("sends below the trigger", () => {
    const fit = decideRequestFit({ budget: budget(), promptSize: 1000, historyIsReducible: true });
    assert.equal(fit.outcome, "send");
  });

  it("compacts first above the trigger when history is reducible", () => {
    const fit = decideRequestFit({ budget: budget(), promptSize: 5000, historyIsReducible: true });
    assert.equal(fit.outcome, "compact_first");
  });

  it("still sends above the trigger when nothing is reducible and P is respected", () => {
    // The 80% trigger is an optimisation; only exceeding P blocks sending.
    const fit = decideRequestFit({ budget: budget(), promptSize: 5000, historyIsReducible: false });
    assert.equal(fit.outcome, "send");
    if (fit.outcome !== "send") return;
    assert.equal(fit.compactedAlready, true);
  });

  it("blocks sending above P", () => {
    const fit = decideRequestFit({ budget: budget(), promptSize: 7000, historyIsReducible: true });
    assert.equal(fit.outcome, "cannot_send");
    if (fit.outcome !== "cannot_send") return;
    assert.equal(fit.reason, "over_budget");
  });
});
