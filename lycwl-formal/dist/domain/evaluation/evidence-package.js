/**
 * Local release-evidence report rendering
 * (V1_EVALUATION_AND_RELEASE.md section 6.3, ADR-0015).
 *
 * The evidence package is local and self-contained: it names the candidate
 * identity, the configuration the samples ran under, every per-sample result, the
 * blockers, and the unknowns. Two rules keep it honest:
 *
 * - **Unknown is written as unknown.** An unmeasured token count, an unpriced
 *   request or a missing gate is not zero and not "n/a". Section 6.3 requires the
 *   package to list unknowns explicitly, so this renderer has no way to omit one.
 * - **The report is text, not a claim.** It states what the records support. It
 *   does not decide to release, and it never turns a `not_established` conclusion
 *   into a recommendation.
 *
 * Rendering is pure: no clock, no filesystem, no network. The caller supplies
 * every identity, so two renderings of the same input are byte-identical.
 */
import { allSamplesPassedSummary, caseReliability } from "./aggregation.js";
export const REPORT_VERSION = "evaluation-report-1";
function describeUsage(record) {
    const usage = record.usage;
    const value = (entry, unit) => entry === null ? "unknown" : `${entry}${unit}`;
    return [
        `input=${value(usage.inputTokens, "")}`,
        `output=${value(usage.outputTokens, "")}`,
        `rounds=${value(usage.modelRounds, "")}`,
        `compactions=${value(usage.compactions, "")}`,
        `active=${value(usage.activeMs, "ms")}`,
        `waiting=${value(usage.waitingMs, "ms")}`,
        `knownUsd=${value(usage.knownUsd, "")}`,
        `unknownCharges=${usage.unknownChargeCount}`,
    ].join(" ");
}
/**
 * Render the evidence package as text.
 *
 * The ordering is fixed so two runs of the same input differ only where the input
 * differs, which is what makes the artifact reviewable rather than merely present.
 */
export function renderEvidencePackage(input) {
    const { report, records, candidate } = input;
    const lines = [
        `# Evaluation evidence package (${REPORT_VERSION})`,
        "",
        "This package reports what recorded samples support. It does not release the",
        "candidate, close any engineering gate, or replace deterministic regressions.",
        "",
        "## Candidate",
        "",
        `identity=${candidate.identity}`,
        `buildSha256=${candidate.buildSha256 ?? "unknown"}`,
        "",
        "## Configuration",
        "",
        `providerId=${report.configuration.providerId}`,
        `modelId=${report.configuration.modelId}`,
        `protocolId=${report.configuration.protocolId}`,
        `notes=${report.configuration.notes}`,
        "",
        "## Conclusion",
        "",
        `conclusion=${report.conclusion}`,
        `blockers=${report.blockers.length === 0 ? "(none)" : report.blockers.join(",")}`,
        "",
    ];
    for (const family of report.families) {
        lines.push(`## Family: ${family.family}`);
        lines.push("");
        lines.push(`planned=${family.plannedTotal} recorded=${family.recorded} pass=${family.pass} fail=${family.fail} blocked=${family.blocked} notRun=${family.notRun} invalidFixture=${family.invalidFixture}`);
        lines.push(`requiredTotal=${family.requiredTotal} perCaseMinimum=${family.perCaseMinimum}`);
        lines.push(`meetsThreshold=${family.meetsThreshold}`);
        lines.push("");
        lines.push("| case | planned | pass | fail | blocked | notRun | invalid | per-case met |");
        lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
        for (const entry of family.cases) {
            lines.push(`| ${entry.caseId} | ${entry.planned} | ${entry.pass} | ${entry.fail} | ${entry.blocked} | ${entry.notRun} | ${entry.invalidFixture} | ${entry.meetsPerCaseMinimum} |`);
        }
        lines.push("");
    }
    lines.push("## Per-sample results");
    lines.push("");
    lines.push("| sample | case | label | branch | runs | usage |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const record of [...records].sort((left, right) => left.sampleId < right.sampleId ? -1 : left.sampleId > right.sampleId ? 1 : 0)) {
        lines.push(`| ${record.sampleId} | ${record.caseId} | ${record.label} | ${record.branch} | ${record.runIdentities.join(",") || "(none)"} | ${describeUsage(record)} |`);
    }
    lines.push("");
    lines.push("## Repetition reliability");
    lines.push("");
    for (const entry of caseReliability(records)) {
        lines.push(`${entry.caseId}: labels=${entry.labels.join(",") || "(none)"} allPassed=${entry.allPassed}`);
    }
    const summary = allSamplesPassedSummary(records);
    lines.push(`tasksAllPassed=${summary.tasksAllPassed}/${summary.tasksWithSamples} (observed count, not an estimate)`);
    lines.push("");
    lines.push("## Mandatory violations");
    lines.push("");
    if (report.violations.length === 0) {
        // Not observing one is not proof of zero risk; say so.
        lines.push("(none observed in this batch; absence is not proof of zero risk)");
    }
    else {
        for (const violation of report.violations) {
            lines.push(`${violation.sampleId} ${violation.caseId} ${violation.kind}: ${violation.detail}`);
        }
    }
    lines.push("");
    lines.push("## False verification claims");
    lines.push("");
    if (report.falseVerifications.length === 0) {
        lines.push("(none)");
    }
    else {
        for (const claim of report.falseVerifications) {
            lines.push(`${claim.sampleId} ${claim.caseId} ${claim.kind}`);
        }
    }
    lines.push("");
    lines.push("## Engineering gates");
    lines.push("");
    for (const gate of input.gates) {
        lines.push(`${gate.id}: ${gate.status} ${gate.note}`);
    }
    lines.push("");
    lines.push("## Known defects");
    lines.push("");
    if (input.knownDefects.length === 0)
        lines.push("(none recorded)");
    else
        for (const defect of input.knownDefects)
            lines.push(`- ${defect}`);
    lines.push("");
    lines.push("## Not run or blocked");
    lines.push("");
    if (input.notRunOrBlocked.length === 0)
        lines.push("(none)");
    else
        for (const item of input.notRunOrBlocked)
            lines.push(`- ${item}`);
    lines.push("");
    lines.push("## Support scope");
    lines.push("");
    lines.push(input.supportScope);
    lines.push("");
    lines.push("## Rollback");
    lines.push("");
    lines.push(input.rollback);
    lines.push("");
    return lines.join("\n");
}
