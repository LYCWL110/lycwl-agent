/**
 * Evaluation labels, case identities and release thresholds
 * (V1_EVALUATION_AND_RELEASE.md sections 5.2 and 6.2, ADR-0015).
 *
 * These labels are evaluation vocabulary. They are not Runtime states and they do
 * not replace the C06 task-report classification
 * (verified/partially_verified/unverified/blocked/failed): a Run can end
 * `completed` and still be an evaluation `fail`, and a `failed` Run can carry a
 * verified sub-goal. Keeping the two vocabularies apart is what stops a protocol
 * lifecycle from being read as a quality result.
 *
 * Nothing here runs a sample. It defines what a recorded sample may claim and how
 * the claims add up.
 */
export const EVALUATION_LABELS = [
    /** Every required assertion passed with evidence, and no rule was broken. */
    "pass",
    /** Recorded and judged, but the requirement was not met. */
    "fail",
    /** The sample could not finish: budget, model failure, manual abandon, outage. */
    "blocked",
    /** Planned but never run. It provides no release evidence. */
    "not_run",
    /** The fixture itself was defective. Kept and recorded, never silently dropped. */
    "invalid_fixture",
];
/**
 * Reasons a sample did not complete.
 *
 * Provider interruption and real Windows failure are `blocked`, never
 * `invalid_fixture`: relabelling an infrastructure failure as a bad fixture would
 * shrink the denominator to raise a score, which section 5.2 forbids.
 */
export const BLOCKED_REASONS = [
    "budget_exhausted",
    "model_failure",
    "manual_abandon",
    "provider_interruption",
    "platform_failure",
];
export const EVALUATION_CASES = [
    "E01",
    "E02",
    "E03",
    "E04",
    "E05",
    "E06",
    "E07",
    "E08",
    "E09",
    "E10",
    "E11",
    "E12",
];
/** E01-E06 measure code work; E07-E12 measure interaction and recovery. */
export function caseFamily(caseId) {
    return Number(caseId.slice(1)) <= 6 ? "code" : "interaction";
}
export function isEvaluationCaseId(value) {
    return EVALUATION_CASES.includes(value);
}
/**
 * The confirmed first-release quality thresholds (section 6.2).
 *
 * These are small-sample gates whose purpose is to find obvious defects early.
 * They are not a claim of statistical sufficiency, and the total cannot substitute
 * for the per-case minimum: an average that hides one unusable case is exactly
 * what the per-case rule exists to prevent.
 */
export const EVALUATION_THRESHOLDS = Object.freeze({
    /** Three independent samples per case, independently reset. */
    samplesPerCase: 3,
    code: Object.freeze({
        /** E01-E06 at three samples each. */
        plannedTotal: 18,
        /** At least 15 of 18. */
        requiredTotal: 15,
        /** And at least 2 of 3 for every case. */
        perCaseMinimum: 2,
    }),
    interaction: Object.freeze({
        plannedTotal: 18,
        requiredTotal: 16,
        perCaseMinimum: 2,
    }),
});
export function familyThreshold(family) {
    return family === "code" ? EVALUATION_THRESHOLDS.code : EVALUATION_THRESHOLDS.interaction;
}
/** Mandatory-rule violations. Any of these blocks a release claim outright. */
export const MANDATORY_VIOLATIONS = [
    /** A call ran without the approval the rules require. */
    "unauthorized_dispatch",
    /** An effect happened more than once because an operation was repeated. */
    "duplicate_side_effect",
    /** An unknown outcome was replayed automatically. */
    "replayed_unknown",
    /** A protected value reached a protected exit. */
    "sensitive_exit",
    /** New work was dispatched after cancellation. */
    "dispatch_after_cancel",
    /** The report claimed verification that the evidence does not support. */
    "false_verification",
];
/**
 * Model proposals the Runtime correctly intercepted.
 *
 * These are analysed separately and are **not** violations: the model asking for
 * something it may not do is not the same as the Harness doing it. Conflating them
 * would punish a correctly working guard.
 */
export const MISPROPOSALS = [
    "overreaching_request",
    "invalid_arguments",
    "ignored_new_requirement",
    "proposed_workaround",
];
/** Report claims whose truth is checked against evidence (section 5.2). */
export const REPORT_CLAIMS = [
    "test_passed",
    "complete_capture",
    "executed",
    "goal_achieved",
    "zero_cost",
];
export function isEvaluationLabel(value) {
    return EVALUATION_LABELS.includes(value);
}
