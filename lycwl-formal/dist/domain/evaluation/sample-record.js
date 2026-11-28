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
import { caseFamily, isEvaluationCaseId, } from "./labels.js";
export const SAMPLE_LIMITS = Object.freeze({
    maxIdLength: 128,
    /** Per-sample assertion outcomes; a case cannot plausibly need more. */
    maxAssertions: 256,
    /** Distinct Sessions or Runs one sample may reference. */
    maxRuns: 32,
});
const EMPTY_USAGE = Object.freeze({
    inputTokens: null,
    outputTokens: null,
    modelRounds: null,
    compactions: null,
    activeMs: null,
    waitingMs: null,
    knownUsd: null,
    unknownChargeCount: 0,
});
function isId(value) {
    if (value.length === 0 || value.length > SAMPLE_LIMITS.maxIdLength)
        return false;
    // Printable ASCII without spaces: an id must not be able to smuggle a control
    // character into a report or a file name.
    return /^[\x21-\x7e]+$/.test(value);
}
function nonNegativeIntegerOrNull(value) {
    return value === null || (Number.isSafeInteger(value) && value >= 0);
}
function finiteOrNull(value) {
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
export function deriveLabel(input) {
    if (input.label === "not_run" || input.label === "invalid_fixture")
        return input.label;
    if (input.label === "blocked")
        return "blocked";
    const required = input.assertions.filter((assertion) => assertion.required);
    if (required.length === 0)
        return "fail";
    if (required.some((assertion) => assertion.outcome === "failed"))
        return "fail";
    // An evidence-free "pass" is a model claim, which is never verification.
    if (required.some((assertion) => assertion.outcome === "passed" && !assertion.evidenceBacked)) {
        return "fail";
    }
    if (required.some((assertion) => assertion.outcome === "not_run"))
        return "fail";
    // A false report claim is not a quality pass, whatever the code did.
    if (input.reportClaims.some((claim) => claim.asserted && !claim.supported))
        return "fail";
    return "pass";
}
/**
 * Build a validated sample record.
 *
 * The caller's label is compared against the derived one. A mismatch is refused
 * rather than corrected silently: the runner and the rules disagreeing is a defect
 * in the evaluation, and storing either answer would hide it.
 */
export function createSampleRecord(input) {
    if (!isId(input.sampleId))
        return { ok: false, code: "invalid_identity" };
    if (!isEvaluationCaseId(input.caseId))
        return { ok: false, code: "invalid_case" };
    if (!Number.isSafeInteger(input.caseVersion) || input.caseVersion < 1) {
        return { ok: false, code: "invalid_case" };
    }
    if (input.branch.trim().length === 0)
        return { ok: false, code: "invalid_case" };
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
    const assertionIds = new Set();
    for (const assertion of assertions) {
        if (!isId(assertion.assertionId))
            return { ok: false, code: "invalid_assertions" };
        if (assertionIds.has(assertion.assertionId))
            return { ok: false, code: "invalid_assertions" };
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
    if (!nonNegativeIntegerOrNull(usage.inputTokens) ||
        !nonNegativeIntegerOrNull(usage.outputTokens) ||
        !nonNegativeIntegerOrNull(usage.modelRounds) ||
        !nonNegativeIntegerOrNull(usage.compactions) ||
        !finiteOrNull(usage.activeMs) ||
        !finiteOrNull(usage.waitingMs) ||
        !finiteOrNull(usage.knownUsd) ||
        !Number.isSafeInteger(usage.unknownChargeCount) ||
        usage.unknownChargeCount < 0) {
        return { ok: false, code: "invalid_usage" };
    }
    const derived = deriveLabel({
        label: input.label,
        ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        assertions,
        reportClaims,
    });
    if (derived !== input.label)
        return { ok: false, code: "label_mismatch" };
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
export function isPassingSample(record) {
    return record.label === "pass";
}
