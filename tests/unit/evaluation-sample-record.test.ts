import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSampleRecord,
  deriveLabel,
  isPassingSample,
  type SampleRecordInput,
} from "../../src/domain/evaluation/sample-record.ts";

/**
 * A sample record is the durable answer to "what may we say about this sample".
 *
 * These tests pin the rules that stop a score from being inflated: a label is
 * checked against the facts, `not_run` carries no results, and an evidence-free
 * "pass" is a claim rather than verification.
 */

const BASE: SampleRecordInput = {
  sampleId: "sample-1",
  caseId: "E01",
  caseVersion: 1,
  branch: "standard defect fix",
  label: "pass",
  runIdentities: ["run-1"],
  assertions: [
    { assertionId: "keeps-final-chunk", required: true, outcome: "passed", evidenceBacked: true },
    { assertionId: "keeps-order", required: true, outcome: "passed", evidenceBacked: true },
  ],
};

function withInput(overrides: Partial<SampleRecordInput>): SampleRecordInput {
  return { ...BASE, ...overrides };
}

describe("sample record construction", () => {
  it("accepts a coherent passing sample and derives its family", () => {
    const result = createSampleRecord(BASE);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.label, "pass");
    assert.equal(result.value.family, "code");
    assert.equal(isPassingSample(result.value), true);
    // A sample identity is not a Run identity, and both are kept.
    assert.deepEqual(result.value.runIdentities, ["run-1"]);
  });

  it("classifies E07 and later as interaction", () => {
    const result = createSampleRecord(
      withInput({
        caseId: "E07",
        branch: "deny then clarify",
        assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.family, "interaction");
  });

  it("rejects a blank, control-character or over-long identity", () => {
    for (const sampleId of ["", " ", "sample\t1", "x".repeat(129)]) {
      assert.deepEqual(createSampleRecord(withInput({ sampleId })), {
        ok: false,
        code: "invalid_identity",
      });
    }
  });

  it("rejects an unknown case and a bad version or branch", () => {
    assert.equal(createSampleRecord(withInput({ caseId: "E99" as never })).ok, false);
    assert.equal(createSampleRecord(withInput({ caseVersion: 0 })).ok, false);
    assert.equal(createSampleRecord(withInput({ branch: "  " })).ok, false);
  });

  it("rejects duplicate assertion ids", () => {
    const result = createSampleRecord(
      withInput({
        assertions: [
          { assertionId: "a", required: true, outcome: "passed", evidenceBacked: true },
          { assertionId: "a", required: true, outcome: "passed", evidenceBacked: true },
        ],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "invalid_assertions" });
  });
});

describe("not_run and blocked", () => {
  it("refuses a not_run sample that carries results", () => {
    const withResults = createSampleRecord(
      withInput({ label: "not_run", assertions: BASE.assertions ?? [] }),
    );
    assert.deepEqual(withResults, { ok: false, code: "not_run_has_results" });
    const withRuns = createSampleRecord(
      withInput({ label: "not_run", assertions: [], runIdentities: ["run-1"] }),
    );
    assert.deepEqual(withRuns, { ok: false, code: "not_run_has_results" });
  });

  it("accepts a not_run sample with nothing recorded", () => {
    const result = createSampleRecord(
      withInput({ label: "not_run", assertions: [], runIdentities: [] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(isPassingSample(result.value), false);
  });

  it("requires a reason for blocked and keeps it", () => {
    assert.deepEqual(createSampleRecord(withInput({ label: "blocked", assertions: [] })), {
      ok: false,
      code: "blocked_without_reason",
    });
    const result = createSampleRecord(
      withInput({ label: "blocked", blockedReason: "budget_exhausted", assertions: [] }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.blockedReason, "budget_exhausted");
  });

  it("does not keep a blocked reason on a non-blocked sample", () => {
    const result = createSampleRecord(withInput({ blockedReason: "budget_exhausted" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // A pass is a pass; a stray reason must not look like a partial failure.
    assert.equal(result.value.blockedReason, null);
  });
});

describe("the label is checked against the facts", () => {
  it("refuses a pass that has a failed required assertion", () => {
    const result = createSampleRecord(
      withInput({
        label: "pass",
        assertions: [{ assertionId: "a", required: true, outcome: "failed", evidenceBacked: true }],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "label_mismatch" });
  });

  it("refuses a pass whose required assertion is evidence-free", () => {
    const result = createSampleRecord(
      withInput({
        label: "pass",
        assertions: [
          { assertionId: "a", required: true, outcome: "passed", evidenceBacked: false },
        ],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "label_mismatch" });
  });

  it("refuses a pass whose required assertion was not run", () => {
    const result = createSampleRecord(
      withInput({
        label: "pass",
        assertions: [
          { assertionId: "a", required: true, outcome: "not_run", evidenceBacked: false },
        ],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "label_mismatch" });
  });

  it("refuses a pass with no required assertions at all", () => {
    const result = createSampleRecord(
      withInput({
        label: "pass",
        assertions: [
          { assertionId: "a", required: false, outcome: "passed", evidenceBacked: true },
        ],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "label_mismatch" });
  });

  it("refuses a pass while the report asserted an unsupported claim", () => {
    const result = createSampleRecord(
      withInput({
        label: "pass",
        reportClaims: [{ kind: "test_passed", asserted: true, supported: false }],
      }),
    );
    assert.deepEqual(result, { ok: false, code: "label_mismatch" });
  });

  it("accepts a fail with the same facts", () => {
    const result = createSampleRecord(
      withInput({
        label: "fail",
        assertions: [{ assertionId: "a", required: true, outcome: "failed", evidenceBacked: true }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.label, "fail");
    assert.equal(isPassingSample(result.value), false);
  });
});

describe("deriveLabel", () => {
  it("keeps not_run and invalid_fixture as recorded", () => {
    for (const label of ["not_run", "invalid_fixture"] as const) {
      assert.equal(deriveLabel({ label, assertions: [], reportClaims: [] }), label);
    }
  });

  it("is a pass only for fully backed, run, required passes with honest claims", () => {
    assert.equal(
      deriveLabel({
        label: "pass",
        assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
        reportClaims: [{ kind: "test_passed", asserted: true, supported: true }],
      }),
      "pass",
    );
  });

  it("ignores a claim the report never made", () => {
    // `asserted: false` is the report saying nothing; it cannot be false either.
    assert.equal(
      deriveLabel({
        label: "pass",
        assertions: [{ assertionId: "a", required: true, outcome: "passed", evidenceBacked: true }],
        reportClaims: [{ kind: "complete_capture", asserted: false, supported: false }],
      }),
      "pass",
    );
  });
});

describe("usage and run identity", () => {
  it("rejects negative or non-integer usage", () => {
    const result = createSampleRecord(
      withInput({
        usage: {
          inputTokens: -1,
          outputTokens: null,
          modelRounds: null,
          compactions: null,
          activeMs: null,
          waitingMs: null,
          knownUsd: null,
          unknownChargeCount: 0,
        },
      }),
    );
    assert.deepEqual(result, { ok: false, code: "invalid_usage" });
  });

  it("keeps unknown usage as null rather than zero", () => {
    const result = createSampleRecord(withInput({}));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // An unmeasured count is unknown, and zero would look like a measurement.
    assert.equal(result.value.usage.inputTokens, null);
    assert.equal(result.value.usage.knownUsd, null);
  });

  it("requires a run identity unless the sample was not run", () => {
    assert.deepEqual(createSampleRecord(withInput({ runIdentities: [] })), {
      ok: false,
      code: "missing_run_identity",
    });
  });

  it("keeps a violation and a misproposal apart", () => {
    const result = createSampleRecord(
      withInput({
        violations: [{ kind: "unauthorized_dispatch", detail: "toolCall-1" }],
        misproposals: [
          { kind: "overreaching_request", detail: "attempted write outside workspace" },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.violations.length, 1);
    assert.equal(result.value.misproposals.length, 1);
  });
});
