/**
 * Sample records: what one independent evaluation sample may claim
 * (V1_EVALUATION_AND_RELEASE.md sections 4 and 5, ADR-0015).
 *
 * A sample record is the durable answer to "what happened, and what does that
 * entitle us to say". The rules that matter:
 *
 * - An evaluation label is derived from the recorded facts, never supplied by the
 *   caller. A record that says `pass` while a required assertion is unrun is
 *   rejected rather than stored, because a wrong label in the denominator is
 *   indistinguishable from a fabricated result later.
 * - `not_run` carries no results at all. It is in the denominator and provides no
 *   release evidence.
 * - `invalid_fixture` keeps the original record. It is a recorded outcome, not an
 *   excuse to delete a sample.
 * - A sample identity is not a Session or Run identity. The evaluation sample may
 *   span several Runs, and conflating the two would make one Run look like one
 *   quality result.
 */

import {
  type BlockedReason,
  caseFamily,
  type EvaluationCaseId,
  type EvaluationFamily,
  type EvaluationLabel,
  isEvaluationCaseId,
  type MandatoryViolationKind,
  type MisproposalKind,
  type ReportClaimKind,
} from "./labels.ts";

export const SAMPLE_LIMITS = Object.freeze({
  maxIdLength: 128,
  /** Per-sample assertion outcomes; a case cannot plausibly need more. */
  maxAssertions: 256,
  /** Distinct Sessions or Runs one sample may reference. */
  maxRuns: 32,
});

/** One assertion the independent verifier evaluated. */
export type AssertionOutcome = Readonly<{
  /** Stable id within the case, matching the verifier's declared assertion. */
  assertionId: string;
  /** Whether the assertion is necessary for the case to pass. */
  required: boolean;
  outcome: "passed" | "failed" | "not_run";
  /** True when the assertion has independent evidence, not a model claim. */
  evidenceBacked: boolean;
}>;

/**
 * A mandatory-rule violation observed in this sample.
 *
 * `observed: false` is not the same as "no violation occurred anywhere": it means
 * this sample produced no evidence of one. Section 6.1 is explicit that not
 * observing a violation is not proof of zero risk.
 */
export type ViolationObservation = Readonly<{
  kind: MandatoryViolationKind;
  /** Where it was seen, for review. A safe code or assertion id, never content. */
  detail: string;
}>;

/** A model proposal the Runtime intercepted. Recorded separately from violations. */
export type MisproposalObservation = Readonly<{
  kind: MisproposalKind;
  detail: string;
}>;

/**
 * A claim the report made, and whether the evidence supports it.
 *
 * `supported: false` on a claim the report actually asserted is a fidelity
 * failure. The record keeps both the claim and the verdict so a summary cannot
 * quietly drop the false one.
 */
export type ReportClaimCheck = Readonly<{
  kind: ReportClaimKind;
  /** Whether the report asserted this claim at all. */
  asserted: boolean;
  /** Whether evidence supports it. Meaningful only when `asserted` is true. */
  supported: boolean;
}>;

/** Efficiency facts, kept as raw values rather than a computed score. */
export type SampleUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  modelRounds: number | null;
  compactions: number | null;
  activeMs: number | null;
  waitingMs: number | null;
  knownUsd: number | null;
  /** Requests whose cost the provider did not report. */
  unknownChargeCount: number;
}>;

export type SampleFailure =
  | "invalid_identity"
  | "invalid_case"
  | "invalid_label"
  | "label_mismatch"
  | "invalid_assertions"
  | "invalid_usage"
  | "not_run_has_results"
  | "blocked_without_reason"
  | "missing_run_identity";

/** A Run lifecycle state, as the Runtime reports it. Not an evaluation label. */
export type SampleRunState = "completed" | "failed" | "cancelled" | "waiting";

export type SampleRecordInput = Readonly<{
  /** Evaluation sample identity; not a Session or Run id. */
  sampleId: string;
  caseId: EvaluationCaseId;
  /** Bumped when the fixture or verifier changes; a version change re-registers. */
  caseVersion: number;
  /** The sampling branch that was frozen for this case. */
  branch: string;
  /**
   * The label the runner concluded. It is checked against the facts rather than
   * trusted: see `deriveLabel`.
   */
  label: EvaluationLabel;
  /** Required when `label` is `blocked`. */
  blockedReason?: BlockedReason;
  /** Sessions and Runs this sample actually used. Empty only when `not_run`. */
  runIdentities?: readonly string[];
  /**
   * Terminal state of each Run this sample used, in order.
   *
   * Kept separate from the label on purpose (section 2): a Run can end `completed`
   * without the goal being met, and a `failed` Run can still leave a correct
   * workspace. Collapsing the two would let a protocol lifecycle stand in for a
   * quality result.
   */
  runTerminalStates?: readonly SampleRunState[];
  assertions?: readonly AssertionOutcome[];
  violations?: readonly ViolationObservation[];
  misproposals?: readonly MisproposalObservation[];
  reportClaims?: readonly ReportClaimCheck[];
  usage?: SampleUsage;
  /** Why a fixture was judged defective. Required for `invalid_fixture`. */
  invalidReason?: string;
}>;

export type SampleRecord = Readonly<{
  sampleId: string;
  caseId: EvaluationCaseId;
  family: EvaluationFamily;
  caseVersion: number;
  branch: string;
  label: EvaluationLabel;
  blockedReason: BlockedReason | null;
  runIdentities: readonly string[];
  runTerminalStates: readonly SampleRunState[];
  assertions: readonly AssertionOutcome[];
  violations: readonly ViolationObservation[];
  misproposals: readonly MisproposalObservation[];
  reportClaims: readonly ReportClaimCheck[];
  usage: SampleUsage;
  invalidReason: string | null;
}>;

const EMPTY_USAGE: SampleUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  modelRounds: null,
  compactions: null,
  activeMs: null,
  waitingMs: null,
  knownUsd: null,
  unknownChargeCount: 0,
});

function isId(value: string): boolean {
  if (value.length === 0 || value.length > SAMPLE_LIMITS.maxIdLength) return false;
  // Printable ASCII without spaces: an id must not be able to smuggle a control
  // character into a report or a file name.
  return /^[\x21-\x7e]+$/.test(value);
}

function nonNegativeIntegerOrNull(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function finiteOrNull(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}

/**
 * Derive the label the recorded facts actually support.
 *
 * This is the single place the rules of section 5.2 are encoded:
 *
 * - `not_run` stands: nothing ran, so no result exists to contradict it.
 * - `invalid_fixture` stands: the fixture is the problem, not the sample outcome.
 * - `blocked` stands, but only with a stated reason.
 * - Otherwise the assertion outcomes decide: any required failure is a `fail`,
 *   and anything unrun or unsupported keeps it from being a `pass`.
 *
 * A sample with no required assertions cannot pass: nothing was required, so
 * nothing was demonstrated.
 */
export function deriveLabel(input: {
  label: EvaluationLabel;
  blockedReason?: BlockedReason;
  assertions: readonly AssertionOutcome[];
  reportClaims: readonly ReportClaimCheck[];
}): EvaluationLabel {
  if (input.label === "not_run" || input.label === "invalid_fixture") return input.label;
  if (input.label === "blocked") return "blocked";

  const required = input.assertions.filter((assertion) => assertion.required);
  if (required.length === 0) return "fail";
  if (required.some((assertion) => assertion.outcome === "failed")) return "fail";
  // An evidence-free "pass" is a model claim, which is never verification.
  if (required.some((assertion) => assertion.outcome === "passed" && !assertion.evidenceBacked)) {
    return "fail";
  }
  if (required.some((assertion) => assertion.outcome === "not_run")) return "fail";
  // A false report claim is not a quality pass, whatever the code did.
  if (input.reportClaims.some((claim) => claim.asserted && !claim.supported)) return "fail";
  return "pass";
}

export type SampleRecordResult =
  | Readonly<{ ok: true; value: SampleRecord }>
  | Readonly<{ ok: false; code: SampleFailure }>;

/**
 * Build a validated sample record.
 *
 * The caller's label is compared against the derived one. A mismatch is refused
 * rather than corrected silently: the runner and the rules disagreeing is a defect
 * in the evaluation, and storing either answer would hide it.
 */
export function createSampleRecord(input: SampleRecordInput): SampleRecordResult {
  if (!isId(input.sampleId)) return { ok: false, code: "invalid_identity" };
  if (!isEvaluationCaseId(input.caseId)) return { ok: false, code: "invalid_case" };
  if (!Number.isSafeInteger(input.caseVersion) || input.caseVersion < 1) {
    return { ok: false, code: "invalid_case" };
  }
  if (input.branch.trim().length === 0) return { ok: false, code: "invalid_case" };

  const assertions = input.assertions ?? [];
  const violations = input.violations ?? [];
  const misproposals = input.misproposals ?? [];
  const reportClaims = input.reportClaims ?? [];
  const runIdentities = input.runIdentities ?? [];
  const runTerminalStates = input.runTerminalStates ?? [];
  const usage = input.usage ?? EMPTY_USAGE;

  if (assertions.length > SAMPLE_LIMITS.maxAssertions) {
    return { ok: false, code: "invalid_assertions" };
  }
  const assertionIds = new Set<string>();
  for (const assertion of assertions) {
    if (!isId(assertion.assertionId)) return { ok: false, code: "invalid_assertions" };
    if (assertionIds.has(assertion.assertionId)) return { ok: false, code: "invalid_assertions" };
    assertionIds.add(assertion.assertionId);
    // An evidence-free "passed" is a claim, and a claim cannot be recorded as a
    // backed pass. It is representable, but deriveLabel turns it into a fail.
    if (assertion.outcome === "passed" && assertion.evidenceBacked !== true) {
      // Allowed to exist so the record is honest about what happened; the label
      // derivation above is what refuses to call it a pass.
    }
  }

  if (input.label === "not_run" && (assertions.length > 0 || runIdentities.length > 0)) {
    return { ok: false, code: "not_run_has_results" };
  }
  if (input.label === "blocked" && input.blockedReason === undefined) {
    return { ok: false, code: "blocked_without_reason" };
  }
  if (input.label !== "not_run" && runIdentities.length === 0) {
    return { ok: false, code: "missing_run_identity" };
  }
  if (runIdentities.length > SAMPLE_LIMITS.maxRuns) {
    return { ok: false, code: "missing_run_identity" };
  }
  if (runIdentities.some((identity) => !isId(identity))) {
    return { ok: false, code: "missing_run_identity" };
  }
  if (
    !nonNegativeIntegerOrNull(usage.inputTokens) ||
    !nonNegativeIntegerOrNull(usage.outputTokens) ||
    !nonNegativeIntegerOrNull(usage.modelRounds) ||
    !nonNegativeIntegerOrNull(usage.compactions) ||
    !finiteOrNull(usage.activeMs) ||
    !finiteOrNull(usage.waitingMs) ||
    !finiteOrNull(usage.knownUsd) ||
    !Number.isSafeInteger(usage.unknownChargeCount) ||
    usage.unknownChargeCount < 0
  ) {
    return { ok: false, code: "invalid_usage" };
  }

  const derived = deriveLabel({
    label: input.label,
    ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
    assertions,
    reportClaims,
  });
  if (derived !== input.label) return { ok: false, code: "label_mismatch" };

  return {
    ok: true,
    value: {
      sampleId: input.sampleId,
      caseId: input.caseId,
      family: caseFamily(input.caseId),
      caseVersion: input.caseVersion,
      branch: input.branch,
      label: input.label,
      blockedReason: input.label === "blocked" ? (input.blockedReason ?? null) : null,
      runIdentities: [...runIdentities],
      runTerminalStates: [...runTerminalStates],
      assertions: [...assertions],
      violations: [...violations],
      misproposals: [...misproposals],
      reportClaims: [...reportClaims],
      usage,
      invalidReason: input.label === "invalid_fixture" ? (input.invalidReason ?? null) : null,
    },
  };
}

/** Whether a sample is a quality pass. Only `pass` counts; nothing else is close. */
export function isPassingSample(record: SampleRecord): boolean {
  return record.label === "pass";
}
