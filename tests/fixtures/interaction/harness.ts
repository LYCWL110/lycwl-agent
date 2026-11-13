/**
 * Scripted interaction harness for evaluation cases E07-E12.
 *
 * These cases measure how the Runtime *reacts* to a sequence of user actions, not
 * whether a model solves a task. So the model is a script: it returns predetermined
 * responses in order, and the test controls when approvals, denials, questions and
 * cancellations arrive.
 *
 * Two rules from the specification shape this file:
 *
 * - **Approval is per invocation.** A gate that approves everything would not test
 *   the denial path, and a gate that denies everything would not test the approval
 *   path. Each decision is matched against the preview it is asked about.
 * - **Timing is by event, not by sleep.** A scripted action runs when the Runtime
 *   reaches the state it depends on. A fixed delay would make the test flaky and
 *   would not prove the ordering it claims to prove.
 */

import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
} from "../../../src/ports/approval-gate.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../../src/ports/model-provider.ts";

/**
 * A model whose responses are written in advance.
 *
 * It records every request so a test can assert what the model was asked, which is
 * how the "new requirement reached the plan" cases check their claim.
 */
export type ScriptedModel = Readonly<{
  provider: ModelProvider;
  /** Every request, in order. */
  requests: readonly ProviderRequest[];
  /** How many responses remain unused; a leftover means the script was too short. */
  remaining: () => number;
  /** How many requests have been answered so far. */
  answered: () => number;
}>;

export function scriptedModel(responses: readonly ProviderCompletion[]): ScriptedModel {
  const requests: ProviderRequest[] = [];
  let index = 0;
  return {
    provider: {
      async complete(request: ProviderRequest): Promise<ProviderCompletion> {
        requests.push(request);
        const response = responses[index];
        index += 1;
        // A script that runs out is a test bug, not a Runtime behaviour: returning
        // something invented would hide it.
        if (response === undefined) {
          throw new Error(`scripted model exhausted after ${index - 1} response(s)`);
        }
        return response;
      },
    },
    requests,
    remaining: () => responses.length - index,
    answered: () => index,
  };
}

/**
 * A model driven by a handler instead of a fixed script.
 *
 * E09 needs this: the number of main requests depends on when the Runtime decides
 * to compact, and a fixed array would encode a guess about that. The handler still
 * records every request, so the test can assert what was sent.
 */
export function modelFrom(
  handler: (request: ProviderRequest) => ProviderCompletion | Promise<ProviderCompletion>,
): ScriptedModel {
  const requests: ProviderRequest[] = [];
  let answered = 0;
  let outstanding = 0;
  return {
    provider: {
      async complete(request: ProviderRequest): Promise<ProviderCompletion> {
        requests.push(request);
        outstanding += 1;
        try {
          const response = await handler(request);
          answered += 1;
          return response;
        } finally {
          outstanding -= 1;
        }
      },
    },
    requests,
    // A handler has no script length, so "remaining" reports how many requests are
    // still in flight. Zero means the handler answered everything it was asked.
    remaining: () => outstanding,
    answered: () => answered,
  };
}

/** A completed response with text and no tool calls. */
export function say(text: string): ProviderCompletion {
  return { kind: "completed", text, toolCalls: [] };
}

/** Whether this request is the Runtime's auxiliary compaction request. */
export function isCompactionRequest(request: ProviderRequest): boolean {
  return request.compaction !== undefined;
}

/**
 * The artifact declaration the Runtime put in a compaction request.
 *
 * The Runtime tells the summariser exactly which groups it must cover and how far
 * its coverage must reach, so a scripted answer can be correct without guessing:
 * echoing those two values is the only way a reply can pass validation.
 */
export function compactionDeclaration(
  request: ProviderRequest,
): Readonly<{ sourceMessageIds: readonly string[]; toSeq: number }> {
  const last = request.conversation.at(-1);
  const text = last?.kind === "user" ? last.text : "";
  const marker = "Required JSON shape:\n";
  const start = text.indexOf(marker);
  if (start === -1) throw new Error("compaction request has no declaration block");
  const declaration = JSON.parse(text.slice(start + marker.length)) as {
    sourceMessageIds?: unknown;
    coverage?: { toSeq?: unknown };
  };
  const ids = declaration.sourceMessageIds;
  const toSeq = declaration.coverage?.toSeq;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
    throw new Error("compaction declaration has no source ids");
  }
  if (typeof toSeq !== "number") throw new Error("compaction declaration has no toSeq");
  return { sourceMessageIds: ids, toSeq };
}

/** A compaction artifact that covers exactly what the request asked for. */
export function compactionArtifact(
  request: ProviderRequest,
  overrides: Readonly<Record<string, unknown>> = {},
): Extract<ProviderCompletion, { kind: "completed" }> {
  const declaration = compactionDeclaration(request);
  return {
    kind: "completed",
    toolCalls: [],
    text: JSON.stringify({
      schemaVersion: 1,
      sourceMessageIds: [...declaration.sourceMessageIds],
      coverage: { fromSeq: 1, toSeq: declaration.toSeq },
      goal: "keep the task constraints and finish the allowed fix",
      pinnedConstraintIds: [],
      confirmedDecisionIds: [],
      completedClaims: [],
      activeTaskId: null,
      blockedReasons: [],
      nextActions: [],
      fileReferences: [],
      proposedToolCalls: 0,
      ...overrides,
    }),
  };
}

/** A completed response that requests one tool call. */
export function callTool(
  providerToolCallId: string,
  toolName: string,
  args: unknown,
): ProviderCompletion {
  return {
    kind: "completed",
    text: null,
    toolCalls: [{ providerToolCallId, toolName, arguments: args }],
  };
}

export type ApprovalRule = Readonly<{
  /** Decides one request. Returning null means "no rule matched". */
  match: (request: ApprovalRequest) => ApprovalDecision | null;
}>;

/**
 * An approval gate driven by rules.
 *
 * Each request is offered to every rule in order and the first non-null answer wins.
 * An unmatched request is denied and recorded as unexpected: a test that forgot a
 * rule should fail loudly rather than silently approve.
 */
export type ScriptedApprovals = Readonly<{
  gate: ApprovalGate;
  /** Every request the Runtime made, in order. */
  requests: readonly ApprovalRequest[];
  /** Requests no rule matched. Non-empty means the script was incomplete. */
  unexpected: readonly ApprovalRequest[];
}>;

export function scriptedApprovals(rules: readonly ApprovalRule[]): ScriptedApprovals {
  const requests: ApprovalRequest[] = [];
  const unexpected: ApprovalRequest[] = [];
  return {
    gate: {
      async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
        requests.push(request);
        for (const rule of rules) {
          const decision = rule.match(request);
          if (decision !== null) return decision;
        }
        unexpected.push(request);
        return "denied";
      },
    },
    requests,
    unexpected,
  };
}

/** Approve a request whose preview mentions `needle`. */
export function approveWhen(needle: string): ApprovalRule {
  return {
    match: (request) => (request.safePreview.includes(needle) ? "approved" : null),
  };
}

/** Deny a request whose preview mentions `needle`. */
export function denyWhen(needle: string): ApprovalRule {
  return {
    match: (request) => (request.safePreview.includes(needle) ? "denied" : null),
  };
}

/** Approve every request. Used only where approval is not the thing under test. */
export function approveAll(): ApprovalRule {
  return { match: () => "approved" };
}

/**
 * Wait until a condition holds, polling the Runtime's own state.
 *
 * This is not a sleep: the condition is a predicate over state the Runtime owns, so
 * the test proceeds as soon as the state is reached and fails if it never is.
 */
export async function until(
  predicate: () => boolean,
  options: Readonly<{ timeoutMs?: number; label?: string }> = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not reached: ${options.label ?? "(unnamed)"}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Run a promise and assert it rejects with a specific code.
 *
 * Used where the Runtime is expected to refuse: the code matters, because "it threw"
 * would also pass for an unrelated crash.
 */
export async function expectRejection(
  action: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== expected) {
      throw new Error(`expected rejection ${expected}, received ${message}`);
    }
    return;
  }
  throw new Error(`expected rejection ${expected}, but the call resolved`);
}
