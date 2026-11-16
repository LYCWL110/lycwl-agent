import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateEvaluation } from "../../src/domain/evaluation/aggregation.ts";
import { renderEvidencePackage } from "../../src/domain/evaluation/evidence-package.ts";
import { EVALUATION_CASES, type EvaluationCaseId } from "../../src/domain/evaluation/labels.ts";
import {
  createSampleRecord,
  type SampleRecord,
} from "../../src/domain/evaluation/sample-record.ts";

/**
 * The evidence package is the artifact a reviewer reads.
 *
 * Two properties matter more than the layout: an unknown value must never render
 * as a number, and the package must not read as a release approval. Both are
 * checked here because a report that quietly prints `0` for "not measured" is the
 * failure mode the whole evaluation exists to avoid.
 */

const CONFIG = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  protocolId: "openai_chat",
  notes: "synthetic batch",
};

function sample(
  caseId: EvaluationCaseId,
  index: number,
  label: "pass" | "fail" | "not_run" | "blocked",
): SampleRecord {
  const result = createSampleRecord({
    sampleId: `${caseId}-${index}`,
    caseId,
    caseVersion: 1,
    branch: "frozen branch",
    label,
    ...(label === "blocked" ? { blockedReason: "provider_interruption" as const } : {}),
    ...(label === "not_run" ? {} : { runIdentities: [`run-${caseId}-${index}`] }),
    assertions:
      label === "pass" || label === "fail"
        ? [
            {
              assertionId: "a",
              required: true,
              outcome: label === "pass" ? ("passed" as const) : ("failed" as const),
              evidenceBacked: true,
            },
          ]
        : [],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  if (!result.ok) throw new Error("sample");
  return result.value;
}

function fullBatch(label: "pass" | "fail" = "pass"): SampleRecord[] {
  return EVALUATION_CASES.flatMap((caseId) =>
    [0, 1, 2].map((index) => sample(caseId, index, label)),
  );
}

function packageFor(records: readonly SampleRecord[]) {
  const aggregated = aggregateEvaluation({ configuration: CONFIG, records });
  assert.equal(aggregated.ok, true);
  if (!aggregated.ok) throw new Error("aggregate");
  return {
    aggregated: aggregated.value,
    text: renderEvidencePackage({
      candidate: { identity: "commit-abc", buildSha256: null },
      report: aggregated.value,
      records,
      gates: [
        { id: "G01", status: "open", note: "catalog matrix not delivered" },
        { id: "G05", status: "open", note: "durability not measured" },
      ],
      knownDefects: ["search ledger falls back to disabled on lock failure"],
      notRunOrBlocked: [],
      supportScope: "one local Windows developer; API-key providers only",
      rollback: "previous commit remains installable; no data migration",
    }),
  };
}

describe("evidence package rendering", () => {
  it("renders a passing batch without implying a release", () => {
    const { text } = packageFor(fullBatch());
    assert.match(text, /conclusion=met/u);
    assert.match(text, /blockers=\(none\)/u);
    // The header states the limits of the document itself.
    assert.match(text, /does not release the\s+candidate/u);
    // Unknown build hash is written as unknown, not blank or zero.
    assert.match(text, /buildSha256=unknown/u);
  });

  it("renders an unmeasured value as unknown rather than zero", () => {
    const { text } = packageFor(fullBatch());
    assert.match(text, /input=unknown/u);
    assert.match(text, /knownUsd=unknown/u);
    // A zero would be a measurement; the package must not fabricate one.
    assert.equal(/input=0 /u.test(text), false);
  });

  it("lists every gate as stated, including the open ones", () => {
    const { text } = packageFor(fullBatch());
    assert.match(text, /G01: open/u);
    assert.match(text, /G05: open/u);
  });

  it("states that an absent violation is not proof of zero risk", () => {
    const { text } = packageFor(fullBatch());
    assert.match(text, /absence is not proof of zero risk/u);
  });

  it("renders blockers and does not hide a failing batch", () => {
    const records = fullBatch("fail");
    const { text } = packageFor(records);
    assert.match(text, /conclusion=not_established/u);
    assert.match(text, /total_below_threshold/u);
    assert.match(text, /per_case_below_minimum/u);
  });

  it("is byte-identical for the same input", () => {
    const records = fullBatch();
    assert.equal(packageFor(records).text, packageFor(records).text);
  });

  it("sorts per-sample rows so the artifact is stable", () => {
    const records = [...fullBatch()].reverse();
    const { text } = packageFor(records);
    const rows = text
      .split("\n")
      .filter((line) => /^\| E\d\d-\d /u.test(line))
      .map((line) => line.split("|")[1]?.trim() ?? "");
    const sorted = [...rows].sort();
    assert.deepEqual(rows, sorted);
  });

  it("carries the known defect and the support scope into the artifact", () => {
    const { text } = packageFor(fullBatch());
    assert.match(text, /search ledger falls back to disabled/u);
    assert.match(text, /one local Windows developer/u);
    assert.match(text, /no data migration/u);
  });
});
