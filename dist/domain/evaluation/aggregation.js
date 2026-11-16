/**
 * Sample aggregation and release evidence
 * (V1_EVALUATION_AND_RELEASE.md sections 5.2 and 6.2, ADR-0015).
 *
 * The aggregation answers one question honestly: on the samples that were
 * registered, does the evidence meet the confirmed first-release thresholds? It
 * does not decide whether to release; it reports what the records support and
 * names every reason the answer is not yes.
 *
 * The counting rules are the ones section 5.2 states, and each exists to stop a
 * specific way of inflating a score:
 *
 * - The denominator is the **planned** sample count, not the number that happened
 *   to finish. A blocked or abandoned sample stays in it.
 * - `not_run` contributes nothing positive and cannot be counted as a failure that
 *   is then dropped. It is a hole in the evidence.
 * - `invalid_fixture` is retained and reported. A batch containing one cannot
 *   claim the threshold, because the sample that would have replaced it was never
 *   run.
 * - The total cannot substitute for the per-case minimum.
 * - A mandatory violation or a false verification claim blocks the claim outright,
 *   whatever the pass counts say.
 */
import { caseFamily, EVALUATION_CASES, EVALUATION_THRESHOLDS, familyThreshold, } from "./labels.js";
/** Why a family did not meet its threshold. Ordered by severity. */
export const RELEASE_BLOCKERS = [
    /** A mandatory rule was actually broken in at least one sample. */
    "mandatory_violation",
    /** A report asserted something the evidence does not support. */
    "false_verification",
    /** A registered sample was never run. */
    "sample_not_run",
    /** A fixture was defective, so the batch is incomplete. */
    "invalid_fixture",
    /** Fewer records than the planned sample count. */
    "insufficient_samples",
    /** Some sample was blocked and produced no result. */
    "blocked_sample",
    /** The total passed but at least one case is below its per-case minimum. */
    "per_case_below_minimum",
    /** The total itself is below the confirmed threshold. */
    "total_below_threshold",
];
export const AGGREGATOR_VERSION = "evaluation-aggregator-1";
function tallyCase(caseId, records, planned, perCaseMinimum) {
    const forCase = records.filter((record) => record.caseId === caseId);
    const pass = forCase.filter((record) => record.label === "pass").length;
    return {
        caseId,
        planned,
        pass,
        fail: forCase.filter((record) => record.label === "fail").length,
        blocked: forCase.filter((record) => record.label === "blocked").length,
        notRun: forCase.filter((record) => record.label === "not_run").length,
        invalidFixture: forCase.filter((record) => record.label === "invalid_fixture").length,
        meetsPerCaseMinimum: pass >= perCaseMinimum,
    };
}
function tallyFamily(family, records, plannedPerCase) {
    const threshold = familyThreshold(family);
    const caseIds = EVALUATION_CASES.filter((caseId) => caseFamily(caseId) === family);
    const cases = caseIds.map((caseId) => tallyCase(caseId, records, plannedPerCase, threshold.perCaseMinimum));
    const sum = (key) => cases.reduce((total, entry) => total + entry[key], 0);
    const plannedTotal = plannedPerCase * caseIds.length;
    const recorded = records.filter((record) => record.family === family).length;
    const pass = sum("pass");
    return {
        family,
        plannedTotal,
        recorded,
        pass,
        fail: sum("fail"),
        blocked: sum("blocked"),
        notRun: sum("notRun"),
        invalidFixture: sum("invalidFixture"),
        requiredTotal: threshold.requiredTotal,
        perCaseMinimum: threshold.perCaseMinimum,
        meetsThreshold: pass >= threshold.requiredTotal && cases.every((entry) => entry.meetsPerCaseMinimum),
        cases,
    };
}
/**
 * Aggregate a batch of sample records into a release-evidence report.
 *
 * Ordering of the checks is deliberate. Structural problems are refused outright:
 * a duplicate sample or two versions of one case in one batch makes the
 * denominator ambiguous, and an ambiguous denominator cannot support any claim.
 * Only then are the quality rules applied.
 */
export function aggregateEvaluation(input) {
    const { configuration } = input;
    if (configuration.providerId.trim().length === 0 ||
        configuration.modelId.trim().length === 0 ||
        configuration.protocolId.trim().length === 0) {
        return { ok: false, code: "invalid_configuration" };
    }
    const seen = new Set();
    for (const record of input.records) {
        if (seen.has(record.sampleId))
            return { ok: false, code: "duplicate_sample", detail: record.sampleId };
        seen.add(record.sampleId);
    }
    // Two versions of one case in a single batch would mix frozen states. Section 4
    // requires the version to be frozen per case, so this is a structural refusal.
    const versionByCase = new Map();
    for (const record of input.records) {
        const existing = versionByCase.get(record.caseId);
        if (existing !== undefined && existing !== record.caseVersion) {
            return { ok: false, code: "mixed_case_version", detail: record.caseId };
        }
        versionByCase.set(record.caseId, record.caseVersion);
    }
    const plannedPerCase = input.plannedPerCase ?? EVALUATION_THRESHOLDS.samplesPerCase;
    if (!Number.isSafeInteger(plannedPerCase) || plannedPerCase < 1) {
        return { ok: false, code: "invalid_configuration", detail: "plannedPerCase" };
    }
    const families = [
        tallyFamily("code", input.records, plannedPerCase),
        tallyFamily("interaction", input.records, plannedPerCase),
    ];
    const violations = input.records.flatMap((record) => record.violations.map((violation) => ({
        sampleId: record.sampleId,
        caseId: record.caseId,
        kind: violation.kind,
        detail: violation.detail,
    })));
    const falseVerifications = input.records.flatMap((record) => record.reportClaims
        .filter((claim) => claim.asserted && !claim.supported)
        .map((claim) => ({ sampleId: record.sampleId, caseId: record.caseId, kind: claim.kind })));
    const blockers = [];
    if (violations.length > 0)
        blockers.push("mandatory_violation");
    if (falseVerifications.length > 0)
        blockers.push("false_verification");
    if (families.some((family) => family.notRun > 0))
        blockers.push("sample_not_run");
    if (families.some((family) => family.invalidFixture > 0))
        blockers.push("invalid_fixture");
    if (families.some((family) => family.recorded < family.plannedTotal)) {
        blockers.push("insufficient_samples");
    }
    if (families.some((family) => family.blocked > 0))
        blockers.push("blocked_sample");
    if (families.some((family) => family.cases.some((entry) => !entry.meetsPerCaseMinimum))) {
        blockers.push("per_case_below_minimum");
    }
    if (families.some((family) => family.pass < family.requiredTotal)) {
        blockers.push("total_below_threshold");
    }
    return {
        ok: true,
        value: {
            aggregatorVersion: AGGREGATOR_VERSION,
            configuration: { ...configuration },
            families,
            violations,
            falseVerifications,
            blockers,
            conclusion: blockers.length === 0 ? "met" : "not_established",
        },
    };
}
export function caseReliability(records) {
    return EVALUATION_CASES.map((caseId) => {
        const forCase = records.filter((record) => record.caseId === caseId);
        return {
            caseId,
            labels: forCase.map((record) => record.label),
            // An empty case is not "all passed": nothing was observed.
            allPassed: forCase.length > 0 && forCase.every((record) => record.label === "pass"),
        };
    });
}
/** Total tasks where every registered sample passed, and how many had samples. */
export function allSamplesPassedSummary(records) {
    const reliability = caseReliability(records);
    return {
        tasksAllPassed: reliability.filter((entry) => entry.allPassed).length,
        tasksWithSamples: reliability.filter((entry) => entry.labels.length > 0).length,
    };
}
