import type { InternalEvent } from "../../ports/event-log.ts";

/**
 * Crash-recovery assessment (V1_BASELINE section 7 / G05). Recovery never
 * replays an unknown operation automatically. The four interesting crash
 * cut-points are:
 *
 *  1. before the durable dispatch commit — no intent, nothing started;
 *  2. after the commit, before execution started — intent exists, effect may
 *     or may not have begun;
 *  3. during execution — a side effect may exist;
 *  4. after the result event — the result is known and can be reused.
 */
export type CrashCutPoint =
  | "before_dispatch_commit"
  | "after_commit_before_start"
  | "during_execution"
  | "after_result";

export type CallRecovery =
  | Readonly<{
      kind: "not_started";
      toolCallId: string;
      /** The call may be planned again under a new toolCallId and approval. */
      mayReplan: true;
    }>
  | Readonly<{
      kind: "outcome_unknown";
      toolCallId: string;
      /** Never replay automatically; a read-only verification may be proposed. */
      requiresRecoveryReview: true;
    }>
  | Readonly<{
      kind: "result_known";
      toolCallId: string;
      status: string;
      /** The recorded result can be reused without re-executing. */
      reuseResult: true;
    }>;

export type RecoveryAssessment = Readonly<{
  calls: readonly CallRecovery[];
  /** Approvals that were approved but never consumed must be revoked. */
  grantsToRevoke: readonly string[];
  /** Pending approvals stay pending and are redisplayed, not auto-decided. */
  pendingApprovals: readonly string[];
  /** True when at least one call needs explicit user review before continuing. */
  requiresRecoveryReview: boolean;
  /** Run state after recovery, before any user resume. */
  nextRunState: "active" | "waiting" | "completed" | "failed" | "cancelled";
}>;

export type RecoveryBlocked =
  | Readonly<{ ok: false; code: "sequence_invalid" }>
  | Readonly<{ ok: false; code: "chain_invalid" }>;

export type RecoveryResult = Readonly<{ ok: true; value: RecoveryAssessment }> | RecoveryBlocked;

type CallProgress = {
  toolCallId: string;
  dispatched: boolean;
  started: boolean;
  terminal: string | null;
};

export function assessRecovery(events: readonly InternalEvent[]): RecoveryResult {
  const calls = new Map<string, CallProgress>();
  const requested = new Set<string>();
  const decided = new Map<string, "approved" | "denied">();
  const consumed = new Set<string>();
  const revoked = new Set<string>();
  let lastRunPayload: InternalEvent["payload"] | null = null;

  let expectedSeq = 1;
  let previousEventId: string | null = null;
  let previousHash: string | null = null;

  for (const event of events) {
    if (event.seq !== expectedSeq) return { ok: false, code: "sequence_invalid" };
    if (event.previousEventId !== previousEventId || event.previousHash !== previousHash) {
      return { ok: false, code: "chain_invalid" };
    }
    expectedSeq += 1;
    previousEventId = event.eventId;
    previousHash = event.hash;

    const payload = event.payload;
    switch (payload.kind) {
      case "tool_call_received":
        calls.set(payload.toolCallId, {
          toolCallId: payload.toolCallId,
          dispatched: false,
          started: false,
          terminal: null,
        });
        break;
      case "approval_requested":
        requested.add(payload.approvalId);
        break;
      case "approval_decided":
        decided.set(payload.approvalId, payload.decision);
        break;
      case "tool_dispatch_committed":
        ensureCall(calls, payload.toolCallId).dispatched = true;
        if (payload.approvalId !== null) consumed.add(payload.approvalId);
        break;
      case "tool_execution_started":
        ensureCall(calls, payload.toolCallId).started = true;
        break;
      case "tool_execution_finished":
        ensureCall(calls, payload.toolCallId).terminal = payload.status;
        break;
      case "tool_execution_denied":
        ensureCall(calls, payload.toolCallId).terminal = "denied";
        break;
      case "tool_call_cancelled":
        ensureCall(calls, payload.toolCallId).terminal = "cancelled";
        break;
      case "approval_grant_revoked":
        revoked.add(payload.approvalId);
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
      case "run_waiting":
        lastRunPayload = payload;
        break;
      default:
        break;
    }
  }

  const recovered: CallRecovery[] = [];
  for (const call of calls.values()) {
    if (call.terminal !== null) {
      recovered.push({
        kind: "result_known",
        toolCallId: call.toolCallId,
        status: call.terminal,
        reuseResult: true,
      });
      continue;
    }
    if (!call.dispatched) {
      recovered.push({ kind: "not_started", toolCallId: call.toolCallId, mayReplan: true });
      continue;
    }
    // Dispatched with no terminal outcome: the side effect may already exist.
    recovered.push({
      kind: "outcome_unknown",
      toolCallId: call.toolCallId,
      requiresRecoveryReview: true,
    });
  }

  const grantsToRevoke = [...decided.entries()]
    .filter(([approvalId, decision]) => {
      return decision === "approved" && !consumed.has(approvalId) && !revoked.has(approvalId);
    })
    .map(([approvalId]) => approvalId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const pendingApprovals = [...requested]
    .filter((approvalId) => !decided.has(approvalId))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const requiresRecoveryReview = recovered.some(
    (call) => call.kind === "outcome_unknown" || call.kind === "not_started",
  );

  return {
    ok: true,
    value: {
      calls: recovered,
      grantsToRevoke,
      pendingApprovals,
      requiresRecoveryReview,
      nextRunState: deriveNextRunState(lastRunPayload, requiresRecoveryReview),
    },
  };
}

function ensureCall(calls: Map<string, CallProgress>, toolCallId: string): CallProgress {
  const existing = calls.get(toolCallId);
  if (existing !== undefined) return existing;
  const created: CallProgress = {
    toolCallId,
    dispatched: false,
    started: false,
    terminal: null,
  };
  calls.set(toolCallId, created);
  return created;
}

function deriveNextRunState(
  lastRunPayload: InternalEvent["payload"] | null,
  requiresRecoveryReview: boolean,
): RecoveryAssessment["nextRunState"] {
  if (lastRunPayload === null) return requiresRecoveryReview ? "waiting" : "active";
  switch (lastRunPayload.kind) {
    case "run_completed":
      return requiresRecoveryReview ? "waiting" : "completed";
    case "run_failed":
      return "failed";
    case "run_cancelled":
      return "cancelled";
    case "run_waiting":
      return "waiting";
    default:
      return requiresRecoveryReview ? "waiting" : "active";
  }
}

/**
 * Classify the crash cut-point for one call from its recorded events. Used by
 * crash-injection tests and by a future recovery UI.
 */
export function classifyCrashCutPoint(events: readonly InternalEvent[]): CrashCutPoint | null {
  let dispatched = false;
  let started = false;
  let terminal = false;
  for (const event of events) {
    switch (event.payload.kind) {
      case "tool_dispatch_committed":
        dispatched = true;
        break;
      case "tool_execution_started":
        started = true;
        break;
      case "tool_execution_finished":
      case "tool_execution_denied":
      case "tool_call_cancelled":
        terminal = true;
        break;
      default:
        break;
    }
  }
  if (terminal) return "after_result";
  if (started) return "during_execution";
  if (dispatched) return "after_commit_before_start";
  return "before_dispatch_commit";
}
