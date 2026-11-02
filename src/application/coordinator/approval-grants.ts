import type { InternalEvent } from "./internal-events.ts";

/**
 * Event-derived ApprovalGrant projection. This is not a separately mutable
 * authorization database: grant state is recomputed from the durable event
 * chain so restart never resurrects an approval.
 */
export type ApprovalGrantState = "available" | "consumed" | "revoked";

export type ApprovalGrantProjection =
  | Readonly<{ ok: true; grants: Readonly<Record<string, ApprovalGrantState>> }>
  | Readonly<{
      ok: false;
      code:
        | "decision_without_request"
        | "dispatch_without_grant"
        | "grant_already_consumed"
        | "revoke_without_grant";
    }>;

export function projectApprovalGrants(events: readonly InternalEvent[]): ApprovalGrantProjection {
  const requested = new Set<string>();
  const grants: Record<string, ApprovalGrantState> = {};

  for (const event of events) {
    const payload = event.payload;
    switch (payload.kind) {
      case "approval_requested":
        requested.add(payload.approvalId);
        break;
      case "approval_decided": {
        if (!requested.has(payload.approvalId)) {
          return { ok: false, code: "decision_without_request" };
        }
        if (payload.decision === "approved") grants[payload.approvalId] = "available";
        break;
      }
      case "tool_dispatch_committed": {
        if (payload.approvalId === null) break;
        const state = grants[payload.approvalId];
        if (state === "consumed") return { ok: false, code: "grant_already_consumed" };
        if (state !== "available") return { ok: false, code: "dispatch_without_grant" };
        grants[payload.approvalId] = "consumed";
        break;
      }
      case "approval_grant_revoked": {
        if (grants[payload.approvalId] !== "available") {
          return { ok: false, code: "revoke_without_grant" };
        }
        grants[payload.approvalId] = "revoked";
        break;
      }
      default:
        break;
    }
  }

  return { ok: true, grants };
}
