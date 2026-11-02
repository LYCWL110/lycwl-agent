/**
 * Approval-wait resolution. C01 requires a matching approval reply to resolve
 * its own wait without a second ResumeRun, while commandId makes duplicate
 * replies idempotent and prevents a grant from being consumed twice.
 */
export type ApprovalWait = Readonly<{
  approvalId: string;
  toolCallId: string;
  waitToken: string;
  requestVersion: number;
}>;

export type ApprovalReply = Readonly<{
  commandId: string;
  approvalId: string;
  toolCallId: string;
  requestVersion: number;
  decision: "approved" | "denied";
}>;

export type ApprovalWaitRegistry = Readonly<{
  handledCommandIds: Readonly<Record<string, "approved" | "denied">>;
}>;

export function emptyApprovalWaitRegistry(): ApprovalWaitRegistry {
  return { handledCommandIds: {} };
}

export type ApprovalWaitResolution =
  | Readonly<{
      ok: true;
      decision: "approved" | "denied";
      duplicate: boolean;
      registry: ApprovalWaitRegistry;
    }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_identity"
        | "unknown_approval"
        | "tool_call_mismatch"
        | "stale_version"
        | "conflicting_reply";
    }>;

export function resolveApprovalReply(
  wait: ApprovalWait | null,
  registry: ApprovalWaitRegistry,
  reply: ApprovalReply,
): ApprovalWaitResolution {
  if (
    reply.commandId.length === 0 ||
    reply.approvalId.length === 0 ||
    reply.toolCallId.length === 0
  ) {
    return { ok: false, code: "invalid_identity" };
  }

  const alreadyHandled = registry.handledCommandIds[reply.commandId];
  if (alreadyHandled !== undefined) {
    return alreadyHandled === reply.decision
      ? { ok: true, decision: alreadyHandled, duplicate: true, registry }
      : { ok: false, code: "conflicting_reply" };
  }

  if (wait === null) return { ok: false, code: "unknown_approval" };
  if (wait.approvalId !== reply.approvalId) return { ok: false, code: "unknown_approval" };
  if (wait.toolCallId !== reply.toolCallId) return { ok: false, code: "tool_call_mismatch" };
  if (wait.requestVersion !== reply.requestVersion) {
    return { ok: false, code: "stale_version" };
  }

  return {
    ok: true,
    decision: reply.decision,
    duplicate: false,
    registry: {
      handledCommandIds: {
        ...registry.handledCommandIds,
        [reply.commandId]: reply.decision,
      },
    },
  };
}

/**
 * After a restart an approved but unused grant must be revoked and reapproved.
 * The original decision stays immutable; only the derived grant changes.
 */
export function grantsToRevokeOnRestart(
  grants: Readonly<Record<string, "available" | "consumed" | "revoked">>,
): readonly string[] {
  return Object.entries(grants)
    .filter(([, state]) => state === "available")
    .map(([approvalId]) => approvalId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
