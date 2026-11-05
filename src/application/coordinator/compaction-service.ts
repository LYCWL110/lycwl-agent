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
      // The assistant's own text is a member too. Without it the group's body would
      // consist only of call/result pairs and the summariser would never see what
      // the model said, which is exactly the kind of content compaction is for.
      if (item.text !== null && item.text.length > 0) {
        members.push({ id: `m${seq}`, kind: "message", status: null });
      }
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
    parts.push(renderGroupBodies(input.conversation, group, representation.representation));
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

/**
 * Render a group's body for the summarisation request.
 *
 * `full` sends the actual text the model originally saw, `excerpt` sends a bounded
 * head and tail with an explicit marker, and `reference_only` contributes nothing
 * because the skeleton already states the body never entered. Rendering the member
 * list instead of the text -- the earlier behaviour -- made `full` a lie: the
 * summariser was told a group was fully available while receiving only ids.
 */
function renderGroupBodies(
  conversation: readonly ProviderConversationItem[],
  group: ContextGroup,
  representation: "full" | "excerpt" | "reference_only",
): string {
  if (representation === "reference_only") return "";

  const parts: string[] = [];
  for (const member of group.members) {
    if (member.kind === "tool_call") {
      const call = findCall(conversation, member.id);
      if (call === undefined) {
        parts.push(`tool_call:${member.id} (arguments unavailable)`);
        continue;
      }
      parts.push(`tool_call:${member.id} ${call.toolName} ${JSON.stringify(call.arguments ?? {})}`);
      continue;
    }
    if (member.kind === "tool_result") {
      const result = findToolResult(conversation, member.id);
      const status = member.status ?? "unknown";
      if (result === undefined || result.text === null) {
        parts.push(`tool_result:${member.id} (${status})`);
        continue;
      }
      parts.push(`tool_result:${member.id} (${status}): ${clip(result.text, representation)}`);
      continue;
    }
    const message = messageTextFor(conversation, group);
    parts.push(message === null ? `message:${member.id}` : clip(message, representation));
  }
  return parts.join("\n");
}

const EXCERPT_HEAD = 400;
const EXCERPT_TAIL = 200;

/**
 * Apply the representation's clipping rule.
 *
 * The marker names the fact that text was removed, so a summariser cannot present
 * an excerpt as if it were the whole body.
 */
function clip(text: string, representation: "full" | "excerpt" | "reference_only"): string {
  if (representation === "full") return text;
  if (text.length <= EXCERPT_HEAD + EXCERPT_TAIL) return text;
  const removed = text.length - EXCERPT_HEAD - EXCERPT_TAIL;
  return `${text.slice(0, EXCERPT_HEAD)}\n[truncated ${removed} unit(s)]\n${text.slice(-EXCERPT_TAIL)}`;
}

function findCall(
  conversation: readonly ProviderConversationItem[],
  callId: string,
): Extract<ProviderConversationItem, { kind: "assistant" }>["toolCalls"][number] | undefined {
  for (const item of conversation) {
    if (item.kind !== "assistant") continue;
    const call = item.toolCalls.find((candidate) => candidate.providerToolCallId === callId);
    if (call !== undefined) return call;
  }
  return undefined;
}

function findToolResult(
  conversation: readonly ProviderConversationItem[],
  callId: string,
): Extract<ProviderConversationItem, { kind: "tool_result" }> | undefined {
  for (const item of conversation) {
    if (item.kind === "tool_result" && item.providerToolCallId === callId) return item;
  }
  return undefined;
}

/**
 * Text for the message member of a group.
 *
 * The assistant text is returned for an assistant group; a user group returns the
 * first user text. Groups built from a single message have exactly one candidate,
 * so this does not need to trust the member id.
 */
/**
 * Text for the message member of a group.
 *
 * Position is taken from the group kind rather than the member id: an assistant
 * group yields assistant text, a user group yields user text. Groups are built in
 * conversation order, so the seq disambiguates repeated turns of the same kind.
 */
function messageTextFor(
  conversation: readonly ProviderConversationItem[],
  group: ContextGroup,
): string | null {
  if (group.kind === "user_input") {
    // Count how many user turns precede this group's seq, so the right one is used
    // when a Run has several user messages.
    let remaining = Math.max(1, countKindBefore(conversation, group.seq, "user"));
    for (const item of conversation) {
      if (item.kind !== "user") continue;
      remaining -= 1;
      if (remaining <= 0) return item.text;
    }
    return null;
  }
  let remaining = Math.max(1, countKindBefore(conversation, group.seq, "assistant"));
  for (const item of conversation) {
    if (item.kind !== "assistant" || item.text === null) continue;
    remaining -= 1;
    if (remaining <= 0) return item.text;
  }
  return null;
}

/**
 * How many items of `kind` appear before the group whose seq is `seq`.
 *
 * Seq numbering follows group order, and every group consumes at least one
 * conversation item, so this is a stable positional index.
 */
function countKindBefore(
  conversation: readonly ProviderConversationItem[],
  seq: number,
  kind: "user" | "assistant",
): number {
  let count = 0;
  let groupIndex = 0;
  for (const item of conversation) {
    if (item.kind === kind) count += 1;
    // Each group starts at a user or assistant item; advance the group counter when
    // a new group boundary passes.
    if (item.kind === kind || item.kind === "assistant") groupIndex += 1;
    if (groupIndex > seq) break;
  }
  return count;
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
