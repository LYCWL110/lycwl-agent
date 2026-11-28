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
import { conservativeEstimate } from "./context-budget.js";
export const COMPACTION_LIMITS = Object.freeze({
    /** From C05: at most four compaction operations per Run. */
    maxCompactionsPerRun: 4,
    /** From C05: at most two auxiliary attempts per compaction. */
    maxAuxiliaryAttempts: 2,
    /** Marker inserted where body text was clipped. */
    truncationMarker: "[truncated]",
});
/**
 * Choose the recent suffix: the newest contiguous run of complete groups whose
 * combined tokens fit `recentBudget`.
 *
 * A group is never split. If the newest group alone exceeds the budget it moves
 * entirely into the summarised set and the suffix is empty — splitting a call
 * from its result would produce an illegal protocol history.
 */
export function selectRecentSuffix(groups, recentBudget) {
    const ordered = [...groups].sort((left, right) => left.seq - right.seq);
    const suffix = [];
    let used = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const group = ordered[index];
        if (group === undefined)
            break;
        if (used + group.bodyTokens > recentBudget)
            break;
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
export function estimateSkeletonTokens(group) {
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
export function planCompaction(input) {
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
    const seen = new Set();
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
    const skeletons = summarized.map((group) => ({
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
    const representations = new Map();
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
    const sourceHighWaterSeq = input.groups.reduce((highest, group) => Math.max(highest, group.seq), 0);
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
export function renderSkeletonBlock(skeletons) {
    const lines = [
        "[compaction-coverage]",
        "note=reference_only means the body never entered this request; do not claim to have read it",
    ];
    for (const skeleton of skeletons) {
        lines.push(`- group=${skeleton.groupId} kind=${skeleton.kind} seq=${skeleton.seq} representation=${skeleton.representation}`);
        for (const member of skeleton.members) {
            const status = member.status === null ? "" : ` status=${member.status}`;
            lines.push(`  - ${member.kind}:${member.id}${status}`);
        }
    }
    return lines.join("\n");
}
/**
 * Validate a compaction artifact against the plan.
 *
 * Structural checks cannot prove semantic correctness. They can prove the artifact
 * covers the declared sources, preserves call/result linkage, does not propose
 * tools, and does not silently omit a pinned constraint.
 */
export function validateCompactionArtifact(input) {
    const { artifact } = input;
    if (artifact.schemaVersion !== 1)
        return { ok: false, code: "invalid_structure" };
    if (artifact.proposedToolCalls > 0) {
        return { ok: false, code: "proposed_tool_call" };
    }
    if (!Number.isSafeInteger(artifact.coverage.fromSeq) ||
        !Number.isSafeInteger(artifact.coverage.toSeq) ||
        artifact.coverage.toSeq !== input.plan.sourceHighWaterSeq) {
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
    const skeletonMemberIds = new Set(input.plan.skeletons.flatMap((skeleton) => skeleton.members.map((member) => member.id)));
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
export function unverifiedClaims(artifact) {
    return artifact.completedClaims
        .filter((claim) => claim.evidenceRefs.length === 0)
        .map((claim) => ({ text: claim.text }));
}
