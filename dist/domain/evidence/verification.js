/**
 * Task verification aggregation and report snapshots
 * (V1_DESIGN_SUPPLEMENTS.md S01 sections 6.2/6.3, ADR-0017).
 *
 * C06 keeps four dimensions apart: execution outcome, evidence completeness,
 * result delivery, and task verification. This module computes the fourth and
 * never lets it rewrite the first two. A `verified` report is a statement about
 * evidence, not a claim that the Run succeeded, and a `failed` Run can still have
 * verified sub-goals.
 *
 * The aggregation is deliberately conservative because the expensive mistake here
 * is a false "done":
 * - a passing check that predates a relevant code change does not verify the
 *   current version;
 * - a model's own assessment is a claim, never evidence;
 * - one earlier failure does not make a goal failed forever once a later check
 *   passed, and one later pass does not erase a still-applicable failure.
 */
import { hasSubstantiveEvidence, } from "./evidence-ref.js";
export const VERIFICATION_STATUSES = [
    "verified",
    "partially_verified",
    "unverified",
    "blocked",
    "failed",
];
/**
 * Reassess a recorded check result after a change (ADR-0017 conservative rule).
 *
 * Narrow claims keep applicability only with explicit deterministic evidence that
 * the change is unrelated. A model explanation, a cache hit or a self-filled
 * "current" value cannot substitute for that evidence, which is why this function
 * takes `provenUnrelated` as a caller-supplied fact rather than inferring it.
 */
export function reassessApplicability(_current, change) {
    if (change.scope === "unknown") {
        // An external program may have touched anything; do not assume coverage.
        return "indeterminate";
    }
    if (change.provenUnrelated)
        return "unaffected";
    return "stale";
}
/**
 * Aggregate assertion state into one verification status.
 *
 * Rules, in order:
 * 1. an applicable failure wins over everything, but blockers are still reported;
 * 2. blocked when a required check was denied, required evidence is missing, or an
 *    unknown side effect prevents a conclusion;
 * 3. verified only when every required assertion is passed with current evidence
 *    and nothing is unrun, blocked or unknown;
 * 4. partially_verified when something is verified and something is not;
 * 5. unverified when there is no independent positive evidence.
 */
export function aggregateVerification(assertions) {
    const perAssertion = assertions.map((assertion) => ({
        assertionId: assertion.assertionId,
        status: statusOf(assertion),
    }));
    const blockers = [];
    for (const assertion of assertions) {
        if (!assertion.required)
            continue;
        if (assertion.state === "failed" && isApplicable(assertion.applicability)) {
            continue; // handled as `failed` below, but still recorded per assertion
        }
        if (assertion.unavailableEvidence.length > 0) {
            blockers.push({ assertionId: assertion.assertionId, reason: "evidence_missing" });
        }
        if (assertion.state === "not_run") {
            blockers.push({ assertionId: assertion.assertionId, reason: "not_run_required" });
        }
        if (assertion.applicability === "indeterminate") {
            blockers.push({ assertionId: assertion.assertionId, reason: "unknown_side_effect" });
        }
    }
    const requiredFailures = assertions.filter((assertion) => assertion.required &&
        assertion.kind !== "model_claim" &&
        assertion.state === "failed" &&
        isApplicable(assertion.applicability));
    if (requiredFailures.length > 0) {
        return { status: "failed", blockers, perAssertion };
    }
    const requiredBlocked = blockers.some((blocker) => blocker.reason === "evidence_missing" ||
        blocker.reason === "check_denied" ||
        blocker.reason === "unknown_side_effect" ||
        // A required check that has not run is a blocker too: the goal cannot be
        // declared verified, and "unverified" would understate a known gap.
        blocker.reason === "not_run_required");
    if (requiredBlocked) {
        return { status: "blocked", blockers, perAssertion };
    }
    const required = assertions.filter((assertion) => assertion.required);
    if (required.length === 0) {
        // Nothing required was declared, so nothing can be claimed as verified.
        return { status: "unverified", blockers, perAssertion };
    }
    const allRequiredPassed = required.every((assertion) => assertion.state === "passed" &&
        assertion.kind !== "model_claim" &&
        isApplicable(assertion.applicability) &&
        assertion.unavailableEvidence.length === 0 &&
        hasSubstantiveEvidence(assertion.evidence));
    if (allRequiredPassed) {
        const anyUnrun = required.some((assertion) => assertion.state === "not_run");
        if (!anyUnrun && blockers.length === 0) {
            return { status: "verified", blockers, perAssertion };
        }
    }
    const anyPositive = required.some((assertion) => assertion.state === "passed" &&
        assertion.kind !== "model_claim" &&
        isApplicable(assertion.applicability) &&
        hasSubstantiveEvidence(assertion.evidence));
    if (anyPositive)
        return { status: "partially_verified", blockers, perAssertion };
    return { status: "unverified", blockers, perAssertion };
}
/**
 * A model's own assessment never becomes evidence. This exists so callers do not
 * have to remember that: it always returns a claim assertion.
 */
export function modelClaimAsAssertion(input) {
    return {
        assertionId: input.assertionId,
        kind: "model_claim",
        description: input.description,
        state: input.modelSaysPassed ? "passed" : "unknown",
        // A claim has no independent applicability: it never counts as current proof.
        applicability: "stale",
        evidence: [],
        unavailableEvidence: [],
        required: false,
    };
}
/**
 * Build a report snapshot.
 *
 * The Run state is not included, because Run status is independent: a cancelled or
 * failed Run keeps its own facts, and the verification view must not overwrite
 * them. Equally, rebuilding a snapshot for the same high-water seq must not turn
 * unknown items into successes, which is why the aggregation is recomputed from
 * assertions rather than carried in as a status.
 */
export function buildReportSnapshot(input) {
    if (input.sessionId.length === 0 || input.runId.length === 0) {
        return { ok: false, code: "invalid_identity" };
    }
    if (!Number.isSafeInteger(input.sourceHighWaterSeq) || input.sourceHighWaterSeq < 0) {
        return { ok: false, code: "missing_required_field", detail: "sourceHighWaterSeq" };
    }
    if (input.previousHighWaterSeq !== undefined &&
        input.sourceHighWaterSeq < input.previousHighWaterSeq) {
        // A report cannot claim to describe an older state than one already produced.
        return { ok: false, code: "high_water_regression" };
    }
    if (input.projectionVersion.length === 0 || input.generatorVersion.length === 0) {
        return { ok: false, code: "missing_required_field", detail: "version" };
    }
    return {
        ok: true,
        value: {
            sessionId: input.sessionId,
            runId: input.runId,
            sourceHighWaterSeq: input.sourceHighWaterSeq,
            projectionVersion: input.projectionVersion,
            generatorVersion: input.generatorVersion,
            view: input.view,
            userGoal: input.userGoal,
            latestChange: input.latestChange ?? null,
            assertions: input.assertions,
            verification: aggregateVerification(input.assertions),
            changes: input.changes,
            tests: input.tests,
            unknownSideEffects: input.unknownSideEffects,
            backgroundTasks: input.backgroundTasks,
            wait: input.wait ?? null,
            nextUserActions: input.nextUserActions,
            usage: input.usage,
            evidenceAvailable: input.assertions.length > 0 &&
                input.assertions.every((assertion) => assertion.unavailableEvidence.length === 0),
        },
    };
}
/**
 * Render a bounded text form for the model or TUI.
 *
 * It always shows the blockers and unknown items, so a summary cannot present a
 * clean picture by omitting them.
 */
export function renderReport(report) {
    const lines = [
        `[task-report] view=${report.view} verification=${report.verification.status}`,
        `goal=${report.userGoal}`,
        `highWaterSeq=${report.sourceHighWaterSeq} projection=${report.projectionVersion}`,
    ];
    if (report.latestChange !== null)
        lines.push(`latestChange=${report.latestChange}`);
    for (const entry of report.verification.perAssertion) {
        const assertion = report.assertions.find((candidate) => candidate.assertionId === entry.assertionId);
        const detail = assertion !== undefined && assertion.kind === "supporting_check"
            ? ` (${assertion.description.slice(0, 160)})`
            : "";
        lines.push(`- ${entry.assertionId}: ${entry.status}${detail}`);
    }
    for (const blocker of report.verification.blockers) {
        lines.push(`  blocker: ${blocker.assertionId} ${blocker.reason}`);
    }
    if (report.changes.length > 0) {
        const shown = report.changes.slice(0, 12).map((change) => change.path);
        const suffix = report.changes.length > shown.length
            ? ` (+${report.changes.length - shown.length} more)`
            : "";
        lines.push(`changes=${shown.join(",")}${suffix}`);
    }
    if (report.tests.length > 0) {
        lines.push(`tests=${report.tests.map((test) => `${test.command}:${test.outcome}`).join(" | ")}`);
    }
    if (report.unknownSideEffects.length > 0) {
        lines.push(`unknownSideEffects=${report.unknownSideEffects.join(",")}`);
    }
    if (report.usage.unknownChargeCount > 0) {
        lines.push(`unknownCharges=${report.usage.unknownChargeCount}`);
    }
    if (report.wait !== null) {
        lines.push(`waiting=${report.wait.reason} action=${report.wait.requiredAction}`);
    }
    return lines.join("\n");
}
function isApplicable(applicability) {
    // A stale or indeterminate result cannot support a current claim.
    return applicability === "current" || applicability === "unaffected";
}
function statusOf(assertion) {
    if (assertion.kind === "model_claim")
        return "unverified";
    if (assertion.state === "failed" && isApplicable(assertion.applicability))
        return "failed";
    if (assertion.unavailableEvidence.length > 0)
        return "blocked";
    if (assertion.applicability === "indeterminate")
        return "blocked";
    if (assertion.state === "passed" &&
        isApplicable(assertion.applicability) &&
        hasSubstantiveEvidence(assertion.evidence)) {
        return "verified";
    }
    return "unverified";
}
