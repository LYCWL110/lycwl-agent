export const MODEL_REQUEST_STATES = ["in_flight", "succeeded", "failed", "cancelled"] as const;
export type ModelRequestState = (typeof MODEL_REQUEST_STATES)[number];

export type ModelRequest = Readonly<{
  modelRequestId: string;
  attemptNo: number;
  state: ModelRequestState;
}>;

export type ModelRequestTransition =
  | Readonly<{ ok: true; value: ModelRequest }>
  | Readonly<{ ok: false; code: "invalid_request_identity" | "invalid_transition" }>;

const TERMINAL_STATES: ReadonlySet<ModelRequestState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function beginModelRequest(
  modelRequestId: string,
  attemptNo: number,
): ModelRequestTransition {
  if (modelRequestId.length === 0 || !Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    return { ok: false, code: "invalid_request_identity" };
  }
  return {
    ok: true,
    value: { modelRequestId, attemptNo, state: "in_flight" },
  };
}

export function finishModelRequest(
  request: ModelRequest,
  state: Exclude<ModelRequestState, "in_flight">,
): ModelRequestTransition {
  if (TERMINAL_STATES.has(request.state)) {
    return { ok: false, code: "invalid_transition" };
  }
  return {
    ok: true,
    value: { ...request, state },
  };
}
