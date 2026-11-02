/**
 * Session-ordered cancellation boundary. A cancellation accepted before a
 * dispatch commit prevents it; a cancellation accepted after the commit cannot
 * undo effects and must not be reported as non-execution.
 */
export type CancellationBoundary = Readonly<{
  cancelSeq: number;
  dispatchSeq: number;
}>;

export type CancellationVerdict =
  | Readonly<{ ok: true; outcome: "dispatch_prevented" }>
  | Readonly<{ ok: true; outcome: "dispatch_already_committed" }>
  | Readonly<{ ok: false; code: "invalid_sequence" }>;

export function compareCancellation(boundary: CancellationBoundary): CancellationVerdict {
  const { cancelSeq, dispatchSeq } = boundary;
  if (
    !Number.isSafeInteger(cancelSeq) ||
    !Number.isSafeInteger(dispatchSeq) ||
    cancelSeq < 1 ||
    dispatchSeq < 1
  ) {
    return { ok: false, code: "invalid_sequence" };
  }
  return {
    ok: true,
    outcome: cancelSeq < dispatchSeq ? "dispatch_prevented" : "dispatch_already_committed",
  };
}

/**
 * Cancellation outcome for a tool call whose side effect may already exist.
 * The tool outcome is preserved; cancellation never rewrites it.
 */
export type CancelledCallOutcome = Readonly<{
  toolCallId: string;
  sideEffect: "not_started" | "in_flight" | "completed" | "unknown";
}>;

export type CancelledCallProjection = Readonly<{
  toolCallId: string;
  outcome: "cancelled" | "cancelled_outcome_unknown" | "completed_before_cancel";
  safeCode: string | null;
}>;

export function projectCancelledCall(call: CancelledCallOutcome): CancelledCallProjection {
  switch (call.sideEffect) {
    case "not_started":
      return { toolCallId: call.toolCallId, outcome: "cancelled", safeCode: null };
    case "in_flight":
    case "unknown":
      return {
        toolCallId: call.toolCallId,
        outcome: "cancelled_outcome_unknown",
        safeCode: "cancelled_during_execution",
      };
    case "completed":
      return {
        toolCallId: call.toolCallId,
        outcome: "completed_before_cancel",
        safeCode: null,
      };
  }
}
