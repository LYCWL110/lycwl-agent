/**
 * Compaction source grouping and bounded skeleton-first construction
 * (V1_DESIGN_SUPPLEMENTS.md P02, under ADR-0016).
 *
 * The construction is deliberately not "summarise until it fits". It builds an
 * irreducible skeleton first, fails explicitly when even that cannot fit, and
 * only then fills leftover space with reducible body text from newest to oldest.
 * Randomly dropping groups, constraints or state is never an option.
 *
 * Nothing here calls a model. It decides what a compaction request may contain
 * and proves whether that request can be built at all.
 */

import { conservativeEstimate } from "./context-budget.ts";

export const COMPACTION_LIMITS = Object.freeze({
  /** From C05: at most four compaction operations per Run. */
  maxCompactionsPerRun: 4,
  /** From C05: at most two auxiliary attempts per compaction. */
  maxAuxiliaryAttempts: 2,
  /** Marker inserted where body text was clipped. */
  truncationMarker: "[truncated]",
});

export type ContextGroupKind =
  /** One validated assistant response plus every sibling call and outcome. */
  | "assistant_turn"
  /** A non-tool message, keyed by its actual source. */
  | "user_input"
  | "project_material"
  | "runtime_fact";

export type GroupMember = Readonly<{
  /** Stable id: message id, event id or tool call id. */
  id: string;
  kind: "message" | "tool_call" | "tool_result";
  /** Terminal status for a tool result; `null` for messages. */
  status: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown" | null;
}>;

export type ContextGroup = Readonly<{
  groupId: string;
  kind: ContextGroupKind;
  /** Order in the authoritative log; strictly increasing within a session. */
  seq: number;
  members: readonly GroupMember[];
  /** Estimated tokens of the full model-visible text in this group. */
  bodyTokens: number;
  /**
   * Whether body text may be clipped to an excerpt. Authority/state groups must
   * not be clipped.
   */
  bodyReducible: boolean;
}>;

/**
 * The irreducible identity/order/provenance skeleton for one group. This is what
 * must survive even when no body text fits: it tells the summariser *what it did
 * not see*.
 */
export type GroupSkeleton = Readonly<{
  groupId: string;
  kind: ContextGroupKind;
  seq: number;
  /** Every call and result id, with terminal status preserved verbatim. */
  members: readonly GroupMember[];
  representation: "full" | "excerpt" | "reference_only";
  /** Estimated tokens of the skeleton itself. */
  skeletonTokens: number;
}>;

export type ConstructionFailure =
  | "context_capacity_insufficient"
  | "invalid_group"
  | "too_many_compactions"
  | "group_identity_duplicated";

export type CompactionPlan = Readonly<{
  /** Highest authoritative seq this plan covers. */
  sourceHighWaterSeq: number;
  /** Groups that were already summarised by a parent artifact. */
  parentGroupIds: readonly string[];
  /** Groups summarised in this cycle: parent coverage plus newly old history. */
  summarizedGroupIds: readonly string[];
  /** The newest contiguous complete groups that stay verbatim. */
  recentSuffixGroupIds: readonly string[];
  skeletons: readonly GroupSkeleton[];
  /** Tokens available after the fixed part and skeletons. */
  bodyBudgetTokens: number;
  /** Tokens actually filled with body text. */
  bodyUsedTokens: number;
  estimatedAuxiliaryTokens: number;
  auxiliaryBudgetTokens: number;
}>;

export type PlanResult =
  | Readonly<{ ok: true; value: CompactionPlan }>
  | Readonly<{ ok: false; code: ConstructionFailure; detail?: string }>;

/**
 * Choose the recent suffix: the newest contiguous run of complete groups whose
 * combined tokens fit `recentBudget`.
 *
 * A group is never split. If the newest group alone exceeds the budget it moves
 * entirely into the summarised set and the suffix is empty — splitting a call
 * from its result would produce an illegal protocol history.
 */
export function selectRecentSuffix(
  groups: readonly ContextGroup[],
  recentBudget: number,
): Readonly<{ suffix: readonly ContextGroup[]; summarized: readonly ContextGroup[] }> {
  const ordered = [...groups].sort((left, right) => left.seq - right.seq);
  const suffix: ContextGroup[] = [];
  let used = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const group = ordered[index];
    if (group === undefined) break;
    if (used + group.bodyTokens > recentBudget) break;
    suffix.unshift(group);
    used += group.bodyTokens;
  }
  const suffixIds = new Set(suffix.map((group) => group.groupId));
  return {
    suffix,
    summarized: ordered.filter((group) => !suffixIds.has(group.groupId)),
  };
}

/** Estimated tokens for a group's irreducible skeleton. */
export function estimateSkeletonTokens(group: ContextGroup): number {
  // One token per member identity/status pair, plus a small fixed header. This is
  // an estimate with the same status as every other estimate in the project.
  return group.members.length * 8 + 16;
}

/**
 * Build a bounded compaction plan.
 *
 * Order of operations is contractual:
 * 1. skeleton for every group being summarised;
 * 2. fail if fixed + skeletons already exceeds the auxiliary input budget;
 * 3. fill leftover space with reducible body text, newest old group first.
 */
export function planCompaction(input: {
  groups: readonly ContextGroup[];
  /** Tokens reserved for the fixed part: instructions, task, pinned facts. */
  fixedTokens: number;
  /** Auxiliary input budget Pc = W - Oc - G. */
  auxiliaryBudgetTokens: number;
  recentBudget: number;
  /** Groups already covered by a parent summary artifact. */
  parentGroupIds?: readonly string[];
  /** Compaction operations already spent this Run. */
  compactionsUsed?: number;
}): PlanResult {
  const used = input.compactionsUsed ?? 0;
  if (used >= COMPACTION_LIMITS.maxCompactionsPerRun) {
    return { ok: false, code: "too_many_compactions" };
  }
  if (!Number.isSafeInteger(input.auxiliaryBudgetTokens) || input.auxiliaryBudgetTokens <= 0) {
    return { ok: false, code: "context_capacity_insufficient" };
  }
  if (input.fixedTokens < 0 || input.recentBudget < 0) {
    return { ok: false, code: "invalid_group" };
  }

  const seen = new Set<string>();
  for (const group of input.groups) {
    if (group.groupId.length === 0 || !Number.isSafeInteger(group.seq)) {
      return { ok: false, code: "invalid_group", detail: group.groupId };
    }
    if (seen.has(group.groupId)) {
      return { ok: false, code: "group_identity_duplicated", detail: group.groupId };
    }
    seen.add(group.groupId);
  }

  const { suffix, summarized } = selectRecentSuffix(input.groups, input.recentBudget);

  // Step 1: the skeleton is never optional.
  const skeletons: GroupSkeleton[] = summarized.map((group) => ({
    groupId: group.groupId,
    kind: group.kind,
    seq: group.seq,
    members: group.members,
    representation: "reference_only",
    skeletonTokens: estimateSkeletonTokens(group),
  }));

  const skeletonTokens = skeletons.reduce((total, entry) => total + entry.skeletonTokens, 0);
  const conservativeFixed = conservativeEstimate(input.fixedTokens);
  const conservativeSkeleton = conservativeEstimate(skeletonTokens);

  // Step 2: if even the skeleton cannot fit, fail explicitly. Do not drop groups.
  const bodyBudgetTokens = input.auxiliaryBudgetTokens - conservativeFixed - conservativeSkeleton;
  if (bodyBudgetTokens < 0) {
    return {
      ok: false,
      code: "context_capacity_insufficient",
      detail: `fixed+skeleton=${conservativeFixed + conservativeSkeleton} > budget=${input.auxiliaryBudgetTokens}`,
    };
  }

  // Step 3: fill remaining space with reducible bodies, newest old group first.
  let remaining = bodyBudgetTokens;
  const representations = new Map<string, "full" | "excerpt" | "reference_only">();
  const orderedSummarized = [...summarized].sort((left, right) => right.seq - left.seq);

  for (const group of orderedSummarized) {
    if (!group.bodyReducible) {
      // Non-reducible bodies are part of the fixed part, not fillable content.
      representations.set(group.groupId, "reference_only");
      continue;
    }
    const cost = conservativeEstimate(group.bodyTokens);
    if (cost <= remaining) {
      representations.set(group.groupId, "full");
      remaining -= cost;
      continue;
    }
    // An excerpt costs a bounded fraction; if even that does not fit, only the
    // skeleton remains, and the marker records that its body never entered.
    const excerptCost = conservativeEstimate(Math.ceil(group.bodyTokens * 0.25));
    if (excerptCost <= remaining && remaining > 0) {
      representations.set(group.groupId, "excerpt");
      remaining -= excerptCost;
      continue;
    }
    representations.set(group.groupId, "reference_only");
  }

  const finalSkeletons = skeletons.map((entry) => ({
    ...entry,
    representation: representations.get(entry.groupId) ?? "reference_only",
  }));

  const bodyUsedTokens = Math.max(0, bodyBudgetTokens - Math.max(0, remaining));
  const sourceHighWaterSeq = input.groups.reduce(
    (highest, group) => Math.max(highest, group.seq),
    0,
  );

  // A parent's coverage and this cycle's new groups must not double-count the
  // same source. The caller passes parent ids; the union is reported once.
  const parentGroupIds = [...(input.parentGroupIds ?? [])].sort();
  const summarizedIds = summarized.map((group) => group.groupId).sort();
  for (const parentId of parentGroupIds) {
    if (!summarizedIds.includes(parentId)) {
      // A parent group that is no longer in the summarised set means the plan
      // would silently drop coverage; report it as a construction problem.
      return {
        ok: false,
        code: "invalid_group",
        detail: `parent group ${parentId} is not covered by this plan`,
      };
    }
  }

  return {
    ok: true,
    value: {
      sourceHighWaterSeq,
      parentGroupIds,
      summarizedGroupIds: summarizedIds,
      recentSuffixGroupIds: suffix.map((group) => group.groupId),
      skeletons: finalSkeletons,
      bodyBudgetTokens,
      bodyUsedTokens,
      estimatedAuxiliaryTokens: conservativeFixed + conservativeSkeleton + bodyUsedTokens,
      auxiliaryBudgetTokens: input.auxiliaryBudgetTokens,
    },
  };
}

/**
 * Render the skeleton block for a compaction request.
 *
 * The block states what did not enter the summariser, so a `reference_only` group
 * cannot be mistaken for "fully read". It also pins non-succeeded outcomes, so a
 * summariser cannot silently upgrade a denial or an unknown result into success.
 */
export function renderSkeletonBlock(skeletons: readonly GroupSkeleton[]): string {
  const lines = [
    "[compaction-coverage]",
    "note=reference_only means the body never entered this request; do not claim to have read it",
  ];
  for (const skeleton of skeletons) {
    lines.push(
      `- group=${skeleton.groupId} kind=${skeleton.kind} seq=${skeleton.seq} representation=${skeleton.representation}`,
    );
    for (const member of skeleton.members) {
      const status = member.status === null ? "" : ` status=${member.status}`;
      lines.push(`  - ${member.kind}:${member.id}${status}`);
    }
  }
  return lines.join("\n");
}

export type ArtifactValidationFailure =
  | "invalid_structure"
  | "unknown_source_id"
  | "missing_source_id"
  | "linkage_broken"
  | "proposed_tool_call"
  | "over_budget"
  | "constraint_uncovered";

export type CompactionArtifact = Readonly<{
  schemaVersion: 1;
  sourceMessageIds: readonly string[];
  coverage: Readonly<{ fromSeq: number; toSeq: number }>;
  goal: string;
  pinnedConstraintIds: readonly string[];
  confirmedDecisionIds: readonly string[];
  completedClaims: readonly Readonly<{
    text: string;
    /** Empty when the claim has no independent evidence: stays unverified. */
    evidenceRefs: readonly string[];
  }>[];
  activeTaskId: string | null;
  blockedReasons: readonly string[];
  nextActions: readonly string[];
  fileReferences: readonly string[];
  /** A compaction response must not propose tools or continue the task. */
  proposedToolCalls: number;
}>;

export type ArtifactValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: ArtifactValidationFailure; detail?: string }>;

/**
 * Validate a compaction artifact against the plan.
 *
 * Structural checks cannot prove semantic correctness. They can prove the artifact
 * covers the declared sources, preserves call/result linkage, does not propose
 * tools, and does not silently omit a pinned constraint.
 */
export function validateCompactionArtifact(input: {
  artifact: CompactionArtifact;
  plan: CompactionPlan;
  /** Constraint ids the fixed part pinned and the artifact must still carry. */
  requiredConstraintIds: readonly string[];
  /** Source ids the artifact is required to mention, typically call/result pairs. */
  requiredSourceIds: readonly string[];
  outputBudgetTokens: number;
  estimatedOutputTokens: number;
}): ArtifactValidation {
  const { artifact } = input;
  if (artifact.schemaVersion !== 1) return { ok: false, code: "invalid_structure" };
  if (artifact.proposedToolCalls > 0) {
    return { ok: false, code: "proposed_tool_call" };
  }
  if (
    !Number.isSafeInteger(artifact.coverage.fromSeq) ||
    !Number.isSafeInteger(artifact.coverage.toSeq) ||
    artifact.coverage.toSeq !== input.plan.sourceHighWaterSeq
  ) {
    return {
      ok: false,
      code: "invalid_structure",
      detail: "coverage does not reach the high-water seq",
    };
  }

  const declared = new Set(artifact.sourceMessageIds);
  for (const id of input.requiredSourceIds) {
    if (!declared.has(id)) {
      return { ok: false, code: "missing_source_id", detail: id };
    }
  }

  const planIds = new Set(input.plan.summarizedGroupIds);
  for (const id of artifact.sourceMessageIds) {
    if (!planIds.has(id)) {
      return { ok: false, code: "unknown_source_id", detail: id };
    }
  }

  // Call/result linkage: every skeleton member with a result must appear.
  const skeletonMemberIds = new Set(
    input.plan.skeletons.flatMap((skeleton) => skeleton.members.map((member) => member.id)),
  );
  for (const memberId of skeletonMemberIds) {
    if (input.requiredSourceIds.includes(memberId) && !declared.has(memberId)) {
      return { ok: false, code: "linkage_broken", detail: memberId };
    }
  }

  const artifactsConstraints = new Set(artifact.pinnedConstraintIds);
  for (const required of input.requiredConstraintIds) {
    if (!artifactsConstraints.has(required)) {
      return { ok: false, code: "constraint_uncovered", detail: required };
    }
  }

  if (input.estimatedOutputTokens > input.outputBudgetTokens) {
    return { ok: false, code: "over_budget" };
  }

  return { ok: true };
}

/**
 * Claims with no evidence reference remain unverified narration. This helper
 * exists so a caller cannot accidentally treat `completedClaims` as proven.
 */
export function unverifiedClaims(
  artifact: CompactionArtifact,
): readonly Readonly<{ text: string }>[] {
  return artifact.completedClaims
    .filter((claim) => claim.evidenceRefs.length === 0)
    .map((claim) => ({ text: claim.text }));
}
