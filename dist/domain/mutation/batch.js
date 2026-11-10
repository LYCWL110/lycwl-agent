/**
 * Batch mutation accounting (V1_BEHAVIOR_CONTRACTS section 3). A batch has no
 * global atomicity: each target keeps its own fact, and a failure/unknown result
 * stops the remaining targets without pretending to roll back.
 */
export const BATCH_LIMITS = Object.freeze({
    maxPatchTargets: 64,
    maxDeleteTargets: 16,
    maxRenameTreeEntries: 1_000,
    maxRenameManifestBytes: 1024 * 1024,
});
/**
 * Aggregate per-target facts into the outer invocation status. Only a fully
 * applied batch is `succeeded`; any unknown target wins over failure.
 */
export function summarizeBatch(targets) {
    if (targets.some((fact) => fact.outcome === "outcome_unknown")) {
        return { kind: "outcome_unknown", targets };
    }
    const cancelled = targets.some((fact) => fact.outcome === "failed" && fact.safeCode === "cancelled");
    if (cancelled)
        return { kind: "cancelled", targets };
    if (targets.some((fact) => fact.outcome === "failed")) {
        return { kind: "failed", targets };
    }
    return { kind: "succeeded", targets };
}
/** Mark every target after the stop index as not attempted. */
export function stopRemaining(targets, remaining) {
    return [
        ...targets,
        ...remaining.map((target) => ({
            target,
            outcome: "not_attempted",
            safeCode: null,
        })),
    ];
}
/**
 * Preflight every delete target before any removal. A missing target is a
 * conflict, not an implicit success, and recursion/reparse targets are refused.
 */
export function validateDeleteTargets(requested, facts, options = {}) {
    if (options.recursive === true)
        return { ok: false, code: "recursive_unsupported" };
    if (requested.length === 0)
        return { ok: false, code: "invalid_arguments" };
    if (requested.length > BATCH_LIMITS.maxDeleteTargets) {
        return { ok: false, code: "too_many_targets" };
    }
    const seen = new Set();
    for (const path of requested) {
        if (path.length === 0)
            return { ok: false, code: "invalid_arguments" };
        const key = path.replace(/\\/g, "/").toLowerCase();
        if (seen.has(key))
            return { ok: false, code: "duplicate_target" };
        seen.add(key);
    }
    for (const fact of facts) {
        if (fact.isSymbolicLink)
            return { ok: false, code: "reparse_point_unsupported" };
        if (!fact.exists)
            return { ok: false, code: "missing_target" };
        if (fact.isDirectory && !fact.isEmptyDirectory) {
            return { ok: false, code: "directory_not_empty" };
        }
    }
    return { ok: true, targets: facts };
}
/**
 * Preflight a rename. V1 supports exactly one same-volume, no-overwrite pair and
 * refuses to degrade an incomplete tree preview into partial authorization.
 */
export function validateRename(facts) {
    if (facts.from.length === 0 || facts.to.length === 0) {
        return { ok: false, code: "invalid_arguments" };
    }
    if (!facts.sourceExists)
        return { ok: false, code: "source_missing" };
    if (facts.sourceIsSymbolicLink)
        return { ok: false, code: "reparse_point_unsupported" };
    if (facts.aliasAmbiguous)
        return { ok: false, code: "path_alias_ambiguous" };
    if (facts.targetInsideSource)
        return { ok: false, code: "target_inside_source" };
    if (!facts.sameVolume)
        return { ok: false, code: "different_volume" };
    if (facts.targetExists)
        return { ok: false, code: "target_exists" };
    if (facts.treeEntries > BATCH_LIMITS.maxRenameTreeEntries ||
        facts.manifestBytes > BATCH_LIMITS.maxRenameManifestBytes) {
        return { ok: false, code: "tree_too_large" };
    }
    return { ok: true };
}
export function describeBatch(status) {
    return [
        `batch: ${status.kind}`,
        ...status.targets.map((fact) => `${fact.outcome} ${fact.target}${fact.safeCode === null ? "" : ` (${fact.safeCode})`}`),
    ].join("\n");
}
