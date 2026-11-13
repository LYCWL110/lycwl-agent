/**
 * Paired comparison of two evaluation batches
 * (V1_EVALUATION_AND_RELEASE.md sections 5.3 and 5.4, ADR-0015/ADR-0018).
 *
 * Two rules shape this module:
 *
 * 1. A comparison is **paired per case**. Two batches run under different frozen
 *    states or verifier versions are not comparable, and a comparison that averages
 *    them into one delta would attribute a difference to the change under test when
 *    the task itself moved.
 *
 * 2. A small sample gets raw counts, never a confident verdict. Section 5.3 says
 *    explicitly not to claim a reliable improvement from a small mean difference,
 *    so this module reports the counts and the changed cases and refuses to label
 *    an improvement unless the evidence is a strict, paired, non-tied majority.
 *
 * A comparison is not a release decision. It reports what changed between two
 * batches; whether either batch may claim quality is `aggregateEvaluation`'s
 * answer, and the two are deliberately separate.
 */

import type { EvaluationCaseId } from "./labels.ts";
import { EVALUATION_CASES, EVALUATION_THRESHOLDS } from "./labels.ts";
import type { SampleRecord } from "./sample-record.ts";

export const COMPARISON_VERSION = "evaluation-comparison-1";

/** Per-case outcome under both batches. */
export type PairedCaseOutcome = Readonly<{
  caseId: EvaluationCaseId;
  /** Pass counts under each batch, out of the same planned sample count. */
  baselinePass: number;
  candidatePass: number;
  planned: number;
  /** +1 improved, -1 regressed, 0 unchanged. */
  delta: -1 | 0 | 1;
}>;

export type ComparisonFailure =
  | "mismatched_cases"
  | "mismatched_case_version"
  | "mismatched_planned_count"
  | "empty_batch";

export type ComparisonResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        comparisonVersion: string;
        /** Cases where the candidate passed strictly more samples. */
        improved: readonly EvaluationCaseId[];
        /** Cases where the candidate passed strictly fewer. */
        regressed: readonly EvaluationCaseId[];
        unchanged: readonly EvaluationCaseId[];
        cases: readonly PairedCaseOutcome[];
        /**
         * The honest summary. `improved` requires a strict paired majority of
         * improved over regressed cases; `regressed` the reverse; everything else,
         * including a tie or too few comparable cases, is `inconclusive`.
         */
        verdict: "improved" | "regressed" | "inconclusive";
        /** Why the verdict is what it is, so a reader is not left guessing. */
        reason: string;
      }>;
    }>
  | Readonly<{ ok: false; code: ComparisonFailure; detail?: string }>;

function passCount(records: readonly SampleRecord[], caseId: EvaluationCaseId): number {
  return records.filter((record) => record.caseId === caseId && record.label === "pass").length;
}

function versionOf(records: readonly SampleRecord[], caseId: EvaluationCaseId): number | null {
  const record = records.find((entry) => entry.caseId === caseId);
  return record?.caseVersion ?? null;
}

/**
 * Compare two batches per case.
 *
 * Both batches must cover the same cases at the same case version. A batch that
 * ran fewer samples for a case is refused rather than normalised: scaling a pass
 * count to a common denominator would invent results.
 */
export function compareEvaluationBatches(input: {
  baseline: readonly SampleRecord[];
  candidate: readonly SampleRecord[];
  /** Planned samples per case; both batches must have exactly this many. */
  plannedPerCase?: number;
}): ComparisonResult {
  const { baseline, candidate } = input;
  if (baseline.length === 0 || candidate.length === 0) {
    return { ok: false, code: "empty_batch" };
  }

  const planned = input.plannedPerCase ?? EVALUATION_THRESHOLDS.samplesPerCase;
  if (!Number.isSafeInteger(planned) || planned < 1) {
    return { ok: false, code: "mismatched_planned_count" };
  }

  const cases: PairedCaseOutcome[] = [];
  const improved: EvaluationCaseId[] = [];
  const regressed: EvaluationCaseId[] = [];
  const unchanged: EvaluationCaseId[] = [];

  for (const caseId of EVALUATION_CASES) {
    const baselineRecords = baseline.filter((record) => record.caseId === caseId);
    const candidateRecords = candidate.filter((record) => record.caseId === caseId);
    // A case present in one batch and absent from the other is not a paired
    // comparison; it is a different experiment.
    if ((baselineRecords.length === 0) !== (candidateRecords.length === 0)) {
      return { ok: false, code: "mismatched_cases", detail: caseId };
    }
    if (baselineRecords.length === 0) continue;

    if (baselineRecords.length !== planned || candidateRecords.length !== planned) {
      return { ok: false, code: "mismatched_planned_count", detail: caseId };
    }

    const baselineVersion = versionOf(baselineRecords, caseId);
    const candidateVersion = versionOf(candidateRecords, caseId);
    if (baselineVersion !== candidateVersion) {
      return { ok: false, code: "mismatched_case_version", detail: caseId };
    }

    const baselinePass = passCount(baselineRecords, caseId);
    const candidatePass = passCount(candidateRecords, caseId);
    const delta: -1 | 0 | 1 =
      candidatePass > baselinePass ? 1 : candidatePass < baselinePass ? -1 : 0;
    cases.push({ caseId, baselinePass, candidatePass, planned, delta });
    if (delta === 1) improved.push(caseId);
    else if (delta === -1) regressed.push(caseId);
    else unchanged.push(caseId);
  }

  if (cases.length === 0) return { ok: false, code: "empty_batch" };

  const verdict =
    improved.length > regressed.length
      ? "improved"
      : regressed.length > improved.length
        ? "regressed"
        : "inconclusive";
  const reason =
    verdict === "inconclusive"
      ? improved.length === 0 && regressed.length === 0
        ? "no case changed its pass count"
        : `improved ${improved.length} and regressed ${regressed.length} cases, which does not establish a direction`
      : `${verdict === "improved" ? "improved" : "regressed"} ${Math.max(improved.length, regressed.length)} of ${cases.length} comparable cases`;

  return {
    ok: true,
    value: {
      comparisonVersion: COMPARISON_VERSION,
      improved,
      regressed,
      unchanged,
      cases,
      verdict,
      reason,
    },
  };
}

/**
 * Whether a historical quality result may still support a current claim
 * (section 5.4 / ADR-0018).
 *
 * The distinction is between the recorded result, which never changes, and its
 * applicability now. Only an explicitly compatible change keeps applicability; a
 * model, protocol, endpoint or important generation parameter change makes the old
 * score a different configuration's score.
 */
export const APPLICABILITY_REASONS = [
  /** Nothing relevant changed. */
  "no_relevant_change",
  /** Model identity, protocol, endpoint or a material generation parameter changed. */
  "configuration_changed",
  /** SDK, adapter, prompt, tool contract or context construction changed. */
  "implementation_changed",
  /** The service exposed a rolling alias, so the actual version cannot be fixed. */
  "version_unfixed",
  /** Observed behaviour drifted from what was measured. */
  "observed_drift",
] as const;

export type ApplicabilityReason = (typeof APPLICABILITY_REASONS)[number];

export type QualityApplicability = Readonly<{
  /** Whether the historical result may still support the current support claim. */
  stillApplies: boolean;
  reason: ApplicabilityReason;
  /**
   * What the report may say. It never upgrades the historical result: an
   * inapplicable score stays recorded and visible.
   */
  statement:
    | "historical_result_applies"
    | "historical_result_retained_not_applicable"
    | "historical_result_retained_version_unfixed";
}>;

export function assessQualityApplicability(input: {
  reason: ApplicabilityReason;
}): QualityApplicability {
  switch (input.reason) {
    case "no_relevant_change":
      return {
        stillApplies: true,
        reason: input.reason,
        statement: "historical_result_applies",
      };
    case "version_unfixed":
      return {
        stillApplies: false,
        reason: input.reason,
        statement: "historical_result_retained_version_unfixed",
      };
    default:
      return {
        stillApplies: false,
        reason: input.reason,
        statement: "historical_result_retained_not_applicable",
      };
  }
}
