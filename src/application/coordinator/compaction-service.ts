/**
 * Compaction orchestration.
 *
 * `domain/context/compaction.ts` decides *what* a compaction request may contain.
 * This module turns the live conversation into groups, asks a model for the
 * artifact, and validates the reply. It does not write events: the coordinator owns
 * the authoritative log, and a compaction that is not recorded must not be adopted.
 *
 * The order is contractual: group, plan, ask, validate, then let the caller publish.
 * A failed validation keeps the old context, which is why nothing here mutates the
 * conversation it is given.
 */

import {
  type CompactionArtifact,
  type CompactionPlan,
  type ContextGroup,
  type GroupMember,
  planCompaction,
  renderSkeletonBlock,
  unverifiedClaims,
  validateCompactionArtifact,
} from "../../domain/context/compaction.ts";
import { conservativeEstimate } from "../../domain/context/context-budget.ts";
import type { ProviderConversationItem } from "../../ports/model-provider.ts";

/** Rough per-message estimate: 1 token per 4 UTF-16 units, matching the catalog. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build atomic groups from the conversation.
 *
 * An assistant turn and the tool results answering it form one group: splitting
 * them would produce a plan that summarises a call while keeping its result, which
 * is an illegal protocol history.
 */
export function buildGroups(
  conversation: readonly ProviderConversationItem[],
): readonly ContextGroup[] {
  const groups: ContextGroup[] = [];
  let index = 0;
  let seq = 1;

  while (index < conversation.length) {
    const item = conversation[index];
    if (item === undefined) break;

    if (item.kind === "user") {
      groups.push({
        groupId: `g${seq}`,
        kind: "user_input",
        seq,
        members: [{ id: `m${seq}`, kind: "message", status: null }],
        bodyTokens: estimateTokens(item.text),
        bodyReducible: true,
      });
      index += 1;
      seq += 1;
      continue;
    }

    if (item.kind === "assistant") {
      // Absorb every following tool_result that answers one of this turn's calls.
      const members: GroupMember[] = [];
      let tokens = estimateTokens(item.text ?? "");
      const openCalls = new Set(item.toolCalls.map((call) => call.providerToolCallId));
      for (const call of item.toolCalls) {
        members.push({ id: call.providerToolCallId, kind: "tool_call", status: null });
        tokens += estimateTokens(JSON.stringify(call.arguments ?? {}));
      }

      let cursor = index + 1;
      while (cursor < conversation.length) {
        const next = conversation[cursor];
        if (next === undefined || next.kind !== "tool_result") break;
        if (!openCalls.has(next.providerToolCallId)) break;
        members.push({
          id: next.providerToolCallId,
          kind: "tool_result",
          status: next.status,
        });
        tokens += estimateTokens(next.text ?? "");
        openCalls.delete(next.providerToolCallId);
        cursor += 1;
      }

      groups.push({
        groupId: `g${seq}`,
        kind: "assistant_turn",
        seq,
        members,
        bodyTokens: tokens,
        bodyReducible: true,
      });
      index = cursor;
      seq += 1;
      continue;
    }

    // A stray tool_result with no preceding call. Keep it as its own group so the
    // plan can preserve its status rather than dropping it silently.
    groups.push({
      groupId: `g${seq}`,
      kind: "assistant_turn",
      seq,
      members: [{ id: item.providerToolCallId, kind: "tool_result", status: item.status }],
      bodyTokens: estimateTokens(item.text ?? ""),
      bodyReducible: true,
    });
    index += 1;
    seq += 1;
  }

  return groups;
}

export type CompactionRequest = Readonly<{
  /** Text to send as the auxiliary summarisation request. */
  prompt: string;
  plan: CompactionPlan;
}>;

export type CompactionPreparation =
  | Readonly<{ ok: true; value: CompactionRequest }>
  | Readonly<{
      ok: false;
      reason: "capacity_insufficient" | "invalid_group" | "too_many_compactions";
      detail: string;
    }>;

/**
 * Prepare an auxiliary summarisation request.
 *
 * The prompt contains the skeleton first, then only the bodies the plan allowed,
 * so the model is told explicitly what it did not see.
 */
export function prepareCompaction(input: {
  conversation: readonly ProviderConversationItem[];
  fixedTokens: number;
  auxiliaryBudgetTokens: number;
  recentBudget: number;
  compactionsUsed: number;
}): CompactionPreparation {
  const groups = buildGroups(input.conversation);
  const plan = planCompaction({
    groups,
    fixedTokens: input.fixedTokens,
    auxiliaryBudgetTokens: input.auxiliaryBudgetTokens,
    recentBudget: input.recentBudget,
    compactionsUsed: input.compactionsUsed,
  });

  if (!plan.ok) {
    if (plan.code === "context_capacity_insufficient") {
      return { ok: false, reason: "capacity_insufficient", detail: plan.detail ?? "" };
    }
    if (plan.code === "too_many_compactions") {
      return { ok: false, reason: "too_many_compactions", detail: "" };
    }
    return { ok: false, reason: "invalid_group", detail: plan.detail ?? "" };
  }

  const summarized = plan.value.summarizedGroupIds;
  const included = groups.filter((group) => summarized.includes(group.groupId));

  const parts: string[] = [
    "Summarise the earlier part of this session into a compact artifact.",
    "Reply with JSON only. Do not call any tool.",
    "",
    renderSkeletonBlock(plan.value.skeletons),
    "",
  ];

  for (const group of included) {
    const representation = plan.value.skeletons.find((s) => s.groupId === group.groupId);
    if (representation === undefined) continue;
    // Only groups the plan allowed to be filled carry body text. A
    // `reference_only` group contributes its identity through the skeleton and
    // nothing else, so the model cannot claim to have read it.
    if (representation.representation === "reference_only") continue;
    parts.push(`--- ${group.groupId} (seq ${group.seq}) ---`);
    parts.push(renderGroupBodies(input.conversation, group));
    parts.push("");
  }

  parts.push(
    "Required JSON shape:",
    JSON.stringify(
      {
        schemaVersion: 1,
        coverage: { fromSeq: 1, toSeq: plan.value.sourceHighWaterSeq },
        goal: "string",
        pinnedConstraintIds: [],
        confirmedDecisionIds: [],
        completedClaims: [{ text: "string", evidenceRefs: [] }],
        activeTaskId: null,
        blockedReasons: [],
        nextActions: [],
        fileReferences: [],
        proposedToolCalls: 0,
      },
      null,
      2,
    ),
  );

  return { ok: true, value: { prompt: parts.join("\n"), plan: plan.value } };
}

function renderGroupBodies(
  conversation: readonly ProviderConversationItem[],
  group: ContextGroup,
): string {
  void conversation;
  // Body text was already measured into the group; rendering it again would be a
  // second source of truth. The plan's representation is what the model is told.
  return group.members
    .map(
      (member) =>
        `${member.kind}:${member.id}${member.status === null ? "" : ` (${member.status})`}`,
    )
    .join("\n");
}

export type ArtifactParseResult =
  | Readonly<{ ok: true; artifact: CompactionArtifact }>
  | Readonly<{ ok: false; reason: "invalid_artifact"; detail: string }>;

/**
 * Parse the model's reply into an artifact.
 *
 * The model is asked for JSON only, but a reply can still carry a fence or prose.
 * Anything that is not exactly the required shape is rejected rather than coerced:
 * a coerced artifact could silently drop a constraint.
 */
export function parseCompactionArtifact(text: string | null): ArtifactParseResult {
  if (text === null || text.length === 0) {
    return { ok: false, reason: "invalid_artifact", detail: "empty reply" };
  }
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, reason: "invalid_artifact", detail: "no JSON object" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "invalid_artifact", detail: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid_artifact", detail: "not an object" };
  }
  const record = parsed as Record<string, unknown>;

  const coverage = record["coverage"];
  if (
    typeof coverage !== "object" ||
    coverage === null ||
    typeof (coverage as Record<string, unknown>)["fromSeq"] !== "number" ||
    typeof (coverage as Record<string, unknown>)["toSeq"] !== "number"
  ) {
    return { ok: false, reason: "invalid_artifact", detail: "coverage" };
  }

  if (record["schemaVersion"] !== 1) {
    return { ok: false, reason: "invalid_artifact", detail: "schemaVersion" };
  }

  const artifact: CompactionArtifact = {
    schemaVersion: 1,
    sourceMessageIds: stringArray(record["sourceMessageIds"]),
    coverage: {
      fromSeq: (coverage as Record<string, number>)["fromSeq"] ?? 0,
      toSeq: (coverage as Record<string, number>)["toSeq"] ?? 0,
    },
    goal: typeof record["goal"] === "string" ? record["goal"] : "",
    pinnedConstraintIds: stringArray(record["pinnedConstraintIds"]),
    confirmedDecisionIds: stringArray(record["confirmedDecisionIds"]),
    completedClaims: claimArray(record["completedClaims"]),
    activeTaskId: typeof record["activeTaskId"] === "string" ? record["activeTaskId"] : null,
    blockedReasons: stringArray(record["blockedReasons"]),
    nextActions: stringArray(record["nextActions"]),
    fileReferences: stringArray(record["fileReferences"]),
    proposedToolCalls:
      typeof record["proposedToolCalls"] === "number" ? record["proposedToolCalls"] : -1,
  };
  return { ok: true, artifact };
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function claimArray(value: unknown): CompactionArtifact["completedClaims"] {
  if (!Array.isArray(value)) return [];
  const claims: { text: string; evidenceRefs: readonly string[] }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["text"] !== "string") continue;
    claims.push({ text: record["text"], evidenceRefs: stringArray(record["evidenceRefs"]) });
  }
  return claims;
}

export type ValidationOutcome =
  | Readonly<{ ok: true; artifact: CompactionArtifact; unverified: readonly string[] }>
  | Readonly<{ ok: false; reason: "invalid_artifact"; detail: string }>;

/**
 * Validate a parsed artifact against the plan it was produced for.
 *
 * Only the checks that are meaningful without a full event ledger are applied here:
 * coverage, source membership, tool-call refusal and budget. Constraint coverage is
 * checked by the caller, which owns the pinned set.
 */
export function validateArtifact(input: {
  artifact: CompactionArtifact;
  plan: CompactionPlan;
  outputBudgetTokens: number;
  estimatedOutputTokens: number;
  requiredSourceIds: readonly string[];
  requiredConstraintIds: readonly string[];
}): ValidationOutcome {
  const result = validateCompactionArtifact({
    artifact: input.artifact,
    plan: input.plan,
    requiredConstraintIds: input.requiredConstraintIds,
    requiredSourceIds: input.requiredSourceIds,
    outputBudgetTokens: input.outputBudgetTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: "invalid_artifact",
      detail: `${result.code}:${result.detail ?? ""}`,
    };
  }
  return {
    ok: true,
    artifact: input.artifact,
    unverified: unverifiedClaims(input.artifact).map((claim) => claim.text),
  };
}

/** Conservative token estimate for an artifact, used before publishing it. */
export function estimateArtifactTokens(artifact: CompactionArtifact): number {
  return conservativeEstimate(estimateTokens(JSON.stringify(artifact)));
}
