import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessQualityApplicability,
  compareEvaluationBatches,
} from "../../src/domain/evaluation/comparison.ts";
import type { EvaluationCaseId } from "../../src/domain/evaluation/labels.ts";
import {
  createSampleRecord,
  type SampleRecord,
} from "../../src/domain/evaluation/sample-record.ts";

/**
 * Comparison reports what changed between two batches and refuses to overstate it.
 *
 * The two failure modes this guards against are comparing different experiments
 * and calling a small mean difference an improvement.
 */

function sample(
  caseId: EvaluationCaseId,
  index: number,
  label: "pass" | "fail",
  version = 1,
): SampleRecord {
  const result = createSampleRecord({
    sampleId: `${caseId}-${index}`,
    caseId,
    caseVersion: version,
    branch: "frozen branch",
    label,
    runIdentities: [`run-${caseId}-${index}`],
    assertions: [
      {
        assertionId: "a",
        required: true,
        outcome: label === "pass" ? "passed" : "failed",
        evidenceBacked: true,
      },
    ],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  if (!result.ok) throw new Error("sample");
  return result.value;
}

/** A batch where every case passes every sample except the listed ones. */
function batch(
  failures: readonly Readonly<{ caseId: EvaluationCaseId; index: number }>[] = [],
  version = 1,
): SampleRecord[] {
  const cases: readonly EvaluationCaseId[] = ["E01", "E02", "E03"];
  return cases.flatMap((caseId) =>
    [0, 1, 2].map((index) =>
      sample(
        caseId,
        index,
        failures.some((failure) => failure.caseId === caseId && failure.index === index)
          ? "fail"
          : "pass",
        version,
      ),
    ),
  );
}

describe("paired comparison", () => {
  it("reports an improvement when the candidate passes more cases", () => {
    const result = compareEvaluationBatches({
      baseline: batch([{ caseId: "E01", index: 0 }]),
      candidate: batch(),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.improved, ["E01"]);
    assert.deepEqual(result.value.regressed, []);
    assert.equal(result.value.verdict, "improved");
    const e01 = result.value.cases.find((entry) => entry.caseId === "E01");
    assert.deepEqual(e01, {
      caseId: "E01",
      baselinePass: 2,
      candidatePass: 3,
      planned: 3,
      delta: 1,
    });
  });

  it("reports a regression when the candidate passes fewer cases", () => {
    const result = compareEvaluationBatches({
      baseline: batch(),
      candidate: batch([{ caseId: "E02", index: 1 }]),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.regressed, ["E02"]);
    assert.equal(result.value.verdict, "regressed");
  });

  it("is inconclusive when nothing changed, even with a full batch", () => {
    const result = compareEvaluationBatches({
      baseline: batch(),
      candidate: batch(),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.improved, []);
    assert.deepEqual(result.value.regressed, []);
    assert.equal(result.value.verdict, "inconclusive");
    assert.match(result.value.reason, /no case changed/u);
  });

  it("is inconclusive when one case improved and another regressed", () => {
    const result = compareEvaluationBatches({
      baseline: batch([{ caseId: "E01", index: 0 }]),
      candidate: batch([{ caseId: "E02", index: 0 }]),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.improved, ["E01"]);
    assert.deepEqual(result.value.regressed, ["E02"]);
    assert.equal(result.value.verdict, "inconclusive");
    assert.match(result.value.reason, /does not establish a direction/u);
  });

  it("refuses to compare batches with different case versions", () => {
    const result = compareEvaluationBatches({
      baseline: batch([], 1),
      candidate: batch([], 2),
      plannedPerCase: 3,
    });
    assert.deepEqual(result, { ok: false, code: "mismatched_case_version", detail: "E01" });
  });

  it("refuses to compare batches with different sample counts", () => {
    const result = compareEvaluationBatches({
      baseline: batch(),
      candidate: batch().slice(0, 8),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "mismatched_planned_count");
  });

  it("refuses to compare batches that cover different cases", () => {
    const onlyE01 = batch().filter((record) => record.caseId === "E01");
    const result = compareEvaluationBatches({
      baseline: onlyE01,
      candidate: batch(),
      plannedPerCase: 3,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "mismatched_cases");
  });

  it("refuses an empty batch", () => {
    assert.deepEqual(
      compareEvaluationBatches({ baseline: [], candidate: batch(), plannedPerCase: 3 }),
      { ok: false, code: "empty_batch" },
    );
  });
});

describe("historical quality applicability", () => {
  it("keeps applicability only when nothing relevant changed", () => {
    assert.deepEqual(assessQualityApplicability({ reason: "no_relevant_change" }), {
      stillApplies: true,
      reason: "no_relevant_change",
      statement: "historical_result_applies",
    });
  });

  it("retains but does not apply a score after a configuration change", () => {
    for (const reason of [
      "configuration_changed",
      "implementation_changed",
      "observed_drift",
    ] as const) {
      const result = assessQualityApplicability({ reason });
      assert.equal(result.stillApplies, false);
      // The historical result stays visible; it is not deleted or rewritten.
      assert.equal(result.statement, "historical_result_retained_not_applicable");
    }
  });

  it("distinguishes an unfixed version from a changed one", () => {
    const result = assessQualityApplicability({ reason: "version_unfixed" });
    assert.equal(result.stillApplies, false);
    // A rolling alias is a limitation of the evidence, not proof of a change.
    assert.equal(result.statement, "historical_result_retained_version_unfixed");
  });
});
