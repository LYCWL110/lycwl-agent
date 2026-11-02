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

export type TargetOutcome = "applied" | "failed" | "not_attempted" | "outcome_unknown";

export type TargetFact = Readonly<{
  target: string;
  outcome: TargetOutcome;
  safeCode: string | null;
}>;

export type BatchStatus =
  | Readonly<{ kind: "succeeded"; targets: readonly TargetFact[] }>
  | Readonly<{ kind: "failed"; targets: readonly TargetFact[] }>
  | Readonly<{ kind: "cancelled"; targets: readonly TargetFact[] }>
  | Readonly<{ kind: "outcome_unknown"; targets: readonly TargetFact[] }>;

/**
 * Aggregate per-target facts into the outer invocation status. Only a fully
 * applied batch is `succeeded`; any unknown target wins over failure.
 */
export function summarizeBatch(targets: readonly TargetFact[]): BatchStatus {
  if (targets.some((fact) => fact.outcome === "outcome_unknown")) {
    return { kind: "outcome_unknown", targets };
  }
  const cancelled = targets.some(
    (fact) => fact.outcome === "failed" && fact.safeCode === "cancelled",
  );
  if (cancelled) return { kind: "cancelled", targets };
  if (targets.some((fact) => fact.outcome === "failed")) {
    return { kind: "failed", targets };
  }
  return { kind: "succeeded", targets };
}

/** Mark every target after the stop index as not attempted. */
export function stopRemaining(
  targets: readonly TargetFact[],
  remaining: readonly string[],
): readonly TargetFact[] {
  return [
    ...targets,
    ...remaining.map((target) => ({
      target,
      outcome: "not_attempted" as const,
      safeCode: null,
    })),
  ];
}

export type DeleteFailure =
  | "invalid_arguments"
  | "too_many_targets"
  | "recursive_unsupported"
  | "duplicate_target"
  | "missing_target"
  | "not_a_regular_file"
  | "directory_not_empty"
  | "reparse_point_unsupported"
  | "path_outside_workspace";

export type DeleteTargetFacts = Readonly<{
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  isEmptyDirectory: boolean;
}>;

export type DeleteValidation =
  | Readonly<{ ok: true; targets: readonly DeleteTargetFacts[] }>
  | Readonly<{ ok: false; code: DeleteFailure }>;

/**
 * Preflight every delete target before any removal. A missing target is a
 * conflict, not an implicit success, and recursion/reparse targets are refused.
 */
export function validateDeleteTargets(
  requested: readonly string[],
  facts: readonly DeleteTargetFacts[],
  options: Readonly<{ recursive?: boolean }> = {},
): DeleteValidation {
  if (options.recursive === true) return { ok: false, code: "recursive_unsupported" };
  if (requested.length === 0) return { ok: false, code: "invalid_arguments" };
  if (requested.length > BATCH_LIMITS.maxDeleteTargets) {
    return { ok: false, code: "too_many_targets" };
  }

  const seen = new Set<string>();
  for (const path of requested) {
    if (path.length === 0) return { ok: false, code: "invalid_arguments" };
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return { ok: false, code: "duplicate_target" };
    seen.add(key);
  }

  for (const fact of facts) {
    if (fact.isSymbolicLink) return { ok: false, code: "reparse_point_unsupported" };
    if (!fact.exists) return { ok: false, code: "missing_target" };
    if (fact.isDirectory && !fact.isEmptyDirectory) {
      return { ok: false, code: "directory_not_empty" };
    }
  }
  return { ok: true, targets: facts };
}

export type RenameFailure =
  | "invalid_arguments"
  | "target_exists"
  | "different_volume"
  | "reparse_point_unsupported"
  | "target_inside_source"
  | "path_alias_ambiguous"
  | "tree_too_large"
  | "source_missing";

export type RenameValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: RenameFailure }>;

export type RenameFacts = Readonly<{
  from: string;
  to: string;
  sourceExists: boolean;
  targetExists: boolean;
  sameVolume: boolean;
  sourceIsSymbolicLink: boolean;
  treeEntries: number;
  manifestBytes: number;
  targetInsideSource: boolean;
  aliasAmbiguous: boolean;
}>;

/**
 * Preflight a rename. V1 supports exactly one same-volume, no-overwrite pair and
 * refuses to degrade an incomplete tree preview into partial authorization.
 */
export function validateRename(facts: RenameFacts): RenameValidation {
  if (facts.from.length === 0 || facts.to.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  if (!facts.sourceExists) return { ok: false, code: "source_missing" };
  if (facts.sourceIsSymbolicLink) return { ok: false, code: "reparse_point_unsupported" };
  if (facts.aliasAmbiguous) return { ok: false, code: "path_alias_ambiguous" };
  if (facts.targetInsideSource) return { ok: false, code: "target_inside_source" };
  if (!facts.sameVolume) return { ok: false, code: "different_volume" };
  if (facts.targetExists) return { ok: false, code: "target_exists" };
  if (
    facts.treeEntries > BATCH_LIMITS.maxRenameTreeEntries ||
    facts.manifestBytes > BATCH_LIMITS.maxRenameManifestBytes
  ) {
    return { ok: false, code: "tree_too_large" };
  }
  return { ok: true };
}

export function describeBatch(status: BatchStatus): string {
  return [
    `batch: ${status.kind}`,
    ...status.targets.map(
      (fact) =>
        `${fact.outcome} ${fact.target}${fact.safeCode === null ? "" : ` (${fact.safeCode})`}`,
    ),
  ].join("\n");
}
