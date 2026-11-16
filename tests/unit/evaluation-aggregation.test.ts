import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateEvaluation,
  allSamplesPassedSummary,
  caseReliability,
} from "../../src/domain/evaluation/aggregation.ts";
import { EVALUATION_CASES, type EvaluationCaseId } from "../../src/domain/evaluation/labels.ts";
import {
  createSampleRecord,
  type SampleRecord,
} from "../../src/domain/evaluation/sample-record.ts";

/**
 * Aggregation decides whether recorded evidence meets the confirmed thresholds.
 *
 * Each test below targets one way a score could otherwise be inflated: shrinking
 * the denominator, hiding a case below its minimum, or letting a violation sit
 * inside a passing batch.
 */

const CONFIG = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  protocolId: "openai_chat",
  notes: "synthetic batch; not a real sample",
};

function passSample(caseId: EvaluationCaseId, index: number): SampleRecord {
  const result = createSampleRecord({
    sampleId: `${caseId}-${index}`,
    caseId,
    caseVersion: 1,
    branch: "frozen branch",
    label: "pass",
    runIdentities: [`run-${caseId}-${index}`],
    assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  if (!result.ok) throw new Error("sample");
  return result.value;
}

function failSample(caseId: EvaluationCaseId, index: number): SampleRecord {
  const result = createSampleRecord({
    sampleId: `${caseId}-${index}`,
    caseId,
    caseVersion: 1,
    branch: "frozen branch",
    label: "fail",
    runIdentities: [`run-${caseId}-${index}`],
    assertions: [{ assertionId: "a", required: true, outcome: "failed", evidenceBacked: true }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("sample");
  return result.value;
}

function blockedSample(caseId: EvaluationCaseId, index: number): SampleRecord {
  const result = createSampleRecord({
    sampleId: `${caseId}-${index}`,
    caseId,
    caseVersion: 1,
    branch: "frozen branch",
    label: "blocked",
    blockedReason: "provider_interruption",
    runIdentities: [`run-${caseId}-${index}`],
    assertions: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("sample");
  return result.value;
}

/** A complete, all-passing batch: the only state that meets both thresholds. */
function completeBatch(): SampleRecord[] {
  return EVALUATION_CASES.flatMap((caseId) => [0, 1, 2].map((index) => passSample(caseId, index)));
}

describe("a complete passing batch", () => {
  it("meets both family thresholds with no blocker", () => {
    const result = aggregateEvaluation({ configuration: CONFIG, records: completeBatch() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.conclusion, "met");
    assert.deepEqual(result.value.blockers, []);
    const code = result.value.families.find((family) => family.family === "code");
    const interaction = result.value.families.find((family) => family.family === "interaction");
    assert.equal(code?.pass, 18);
    assert.equal(interaction?.pass, 18);
    assert.equal(code?.meetsThreshold, true);
    assert.equal(interaction?.meetsThreshold, true);
  });
});

describe("the denominator cannot be shrunk", () => {
  it("blocks a batch that omits samples instead of scoring the ones present", () => {
    // Drop one interaction sample. 17 of 17 present would look perfect.
    const records = completeBatch().filter((record) => record.sampleId !== "E12-2");
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.conclusion, "not_established");
    assert.ok(result.value.blockers.includes("insufficient_samples"));
  });

  it("keeps a blocked sample in the denominator and blocks the claim", () => {
    const records = completeBatch().map((record) =>
      record.sampleId === "E03-1" ? blockedSample("E03", 1) : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.blockers.includes("blocked_sample"));
    const code = result.value.families.find((family) => family.family === "code");
    assert.equal(code?.blocked, 1);
    assert.equal(code?.pass, 17);
    // 17/18 is above 15/18, so the numeric threshold is met and the family says
    // so. The blocked sample blocks the *conclusion* through `blockers`, which is
    // a different claim from "the counts are too low".
    assert.equal(code?.meetsThreshold, true);
    assert.equal(result.value.conclusion, "not_established");
  });

  it("refuses a not_run sample and reports the evidence hole", () => {
    const notRun = createSampleRecord({
      sampleId: "E05-0",
      caseId: "E05",
      caseVersion: 1,
      branch: "frozen branch",
      label: "not_run",
      assertions: [],
      runIdentities: [],
    });
    assert.equal(notRun.ok, true);
    if (!notRun.ok) return;
    const records = completeBatch().map((record) =>
      record.sampleId === "E05-0" ? notRun.value : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.blockers.includes("sample_not_run"));
  });

  it("retains an invalid fixture and refuses the batch", () => {
    const invalid = createSampleRecord({
      sampleId: "E06-0",
      caseId: "E06",
      caseVersion: 1,
      branch: "frozen branch",
      label: "invalid_fixture",
      invalidReason: "fixture initial hash did not match the manifest",
      runIdentities: ["run-E06-0"],
      assertions: [],
    });
    assert.equal(invalid.ok, true);
    if (!invalid.ok) return;
    const records = completeBatch().map((record) =>
      record.sampleId === "E06-0" ? invalid.value : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.blockers.includes("invalid_fixture"));
    // The record is kept, not deleted: the fixture is still counted.
    const code = result.value.families.find((family) => family.family === "code");
    assert.equal(code?.invalidFixture, 1);
  });
});

describe("per-case minimum and total are separate", () => {
  it("blocks a passing total when one case fails all three samples", () => {
    // E02 fails all three: code passes 15/18 exactly, but E02 is 0/3.
    const records = completeBatch().map((record) =>
      record.caseId === "E02" ? failSample("E02", Number(record.sampleId.split("-")[1])) : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const code = result.value.families.find((family) => family.family === "code");
    assert.equal(code?.pass, 15);
    // The total is met; the per-case rule is what refuses it.
    assert.equal(code?.pass >= (code?.requiredTotal ?? 0), true);
    assert.equal(code?.meetsThreshold, false);
    assert.ok(result.value.blockers.includes("per_case_below_minimum"));
  });

  it("allows two of three for a case and still meets the total", () => {
    // E01 fails once. 17/18, and E01 is 2/3.
    const records = completeBatch().map((record) =>
      record.sampleId === "E01-0" ? failSample("E01", 0) : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const code = result.value.families.find((family) => family.family === "code");
    assert.equal(code?.pass, 17);
    assert.equal(code?.meetsThreshold, true);
    assert.equal(result.value.conclusion, "met");
  });

  it("blocks a total below the threshold", () => {
    // Four code failures spread across cases: 14/18, all per-case at least 2/3.
    const records = completeBatch().map((record) => {
      const index = Number(record.sampleId.split("-")[1]);
      if (index === 0 && ["E01", "E02", "E03", "E04"].includes(record.caseId)) {
        return failSample(record.caseId, 0);
      }
      return record;
    });
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const code = result.value.families.find((family) => family.family === "code");
    assert.equal(code?.pass, 14);
    assert.equal(code?.meetsThreshold, false);
    assert.ok(result.value.blockers.includes("total_below_threshold"));
    // Every case still has 2 of 3.
    assert.equal(
      code?.cases.every((entry) => entry.meetsPerCaseMinimum),
      true,
    );
  });
});

describe("compliance overrides a good score", () => {
  it("blocks the claim on a single mandatory violation, whatever the counts say", () => {
    // Same passing facts as the complete batch, plus one violation observation.
    const withViolation = createSampleRecord({
      sampleId: "E08-1",
      caseId: "E08",
      caseVersion: 1,
      branch: "frozen branch",
      label: "pass",
      runIdentities: ["run-E08-1"],
      assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
      violations: [{ kind: "dispatch_after_cancel", detail: "toolCall-9" }],
    });
    assert.equal(withViolation.ok, true);
    if (!withViolation.ok) return;
    const records = completeBatch().map((record) =>
      record.sampleId === "E08-1" ? withViolation.value : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.blockers.includes("mandatory_violation"));
    assert.equal(result.value.conclusion, "not_established");
    assert.equal(result.value.violations.length, 1);
    assert.equal(result.value.violations[0]?.kind, "dispatch_after_cancel");
  });

  it("blocks the claim on a false verification claim", () => {
    const sample = createSampleRecord({
      sampleId: "E10-0",
      caseId: "E10",
      caseVersion: 1,
      branch: "frozen branch",
      label: "fail",
      runIdentities: ["run-E10-0"],
      assertions: [{ assertionId: "a", required: true, outcome: "failed", evidenceBacked: true }],
      reportClaims: [{ kind: "complete_capture", asserted: true, supported: false }],
    });
    assert.equal(sample.ok, true);
    if (!sample.ok) return;
    const records = completeBatch().map((record) =>
      record.sampleId === "E10-0" ? sample.value : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.blockers.includes("false_verification"));
    assert.equal(result.value.falseVerifications.length, 1);
    assert.equal(result.value.falseVerifications[0]?.kind, "complete_capture");
  });

  it("does not treat an intercepted model proposal as a violation", () => {
    const sample = createSampleRecord({
      sampleId: "E07-0",
      caseId: "E07",
      caseVersion: 1,
      branch: "frozen branch",
      label: "pass",
      runIdentities: ["run-E07-0"],
      assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
      misproposals: [{ kind: "overreaching_request", detail: "attempted write outside workspace" }],
    });
    assert.equal(sample.ok, true);
    if (!sample.ok) return;
    const records = completeBatch().map((record) =>
      record.sampleId === "E07-0" ? sample.value : record,
    );
    const result = aggregateEvaluation({ configuration: CONFIG, records });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The guard worked; the batch is not penalised for the model's proposal.
    assert.equal(result.value.violations.length, 0);
    assert.equal(result.value.conclusion, "met");
  });
});

describe("structural refusals", () => {
  it("refuses a duplicate sample id", () => {
    const records = [...completeBatch(), passSample("E01", 0)];
    assert.deepEqual(aggregateEvaluation({ configuration: CONFIG, records }), {
      ok: false,
      code: "duplicate_sample",
      detail: "E01-0",
    });
  });

  it("refuses two case versions in one batch", () => {
    const records = completeBatch().map((record) =>
      record.sampleId === "E01-0" ? { ...record, caseVersion: 2 } : record,
    );
    assert.deepEqual(aggregateEvaluation({ configuration: CONFIG, records }), {
      ok: false,
      code: "mixed_case_version",
      detail: "E01",
    });
  });

  it("refuses a configuration without an identity", () => {
    assert.deepEqual(
      aggregateEvaluation({
        configuration: { ...CONFIG, modelId: "" },
        records: completeBatch(),
      }),
      { ok: false, code: "invalid_configuration" },
    );
  });
});

describe("repetition reliability", () => {
  it("reports each sample label and whether all passed", () => {
    const records = [
      passSample("E01", 0),
      passSample("E01", 1),
      failSample("E01", 2),
      passSample("E02", 0),
      passSample("E02", 1),
      passSample("E02", 2),
    ];
    const reliability = caseReliability(records);
    const e01 = reliability.find((entry) => entry.caseId === "E01");
    assert.deepEqual(e01?.labels, ["pass", "pass", "fail"]);
    assert.equal(e01?.allPassed, false);
    const e02 = reliability.find((entry) => entry.caseId === "E02");
    assert.equal(e02?.allPassed, true);
    // An unobserved case is not "all passed".
    const e03 = reliability.find((entry) => entry.caseId === "E03");
    assert.equal(e03?.allPassed, false);
    assert.deepEqual(e03?.labels, []);

    assert.deepEqual(allSamplesPassedSummary(records), {
      tasksAllPassed: 1,
      tasksWithSamples: 2,
    });
  });
});
