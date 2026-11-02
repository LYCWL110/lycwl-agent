export const TOOL_INVOCATION_STATES = [
  "received",
  "validated",
  "awaiting_approval",
  "ready",
  "executing",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "outcome_unknown",
] as const;
export type ToolInvocationState = (typeof TOOL_INVOCATION_STATES)[number];

export type ToolInvocation = Readonly<{
  toolCallId: string;
  state: ToolInvocationState;
}>;

export type ToolInvocationTransition =
  | Readonly<{ ok: true; value: ToolInvocation }>
  | Readonly<{
      ok: false;
      code: "invalid_identity" | "invalid_transition" | "terminal_outcome_immutable";
    }>;

const TERMINAL_STATES: ReadonlySet<ToolInvocationState> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "outcome_unknown",
]);

const NEXT_STATES: Readonly<Record<ToolInvocationState, readonly ToolInvocationState[]>> = {
  received: ["validated", "failed", "cancelled"],
  validated: ["awaiting_approval", "ready", "failed", "cancelled"],
  awaiting_approval: ["ready", "denied", "cancelled"],
  ready: ["executing", "failed", "cancelled"],
  executing: ["succeeded", "failed", "cancelled", "outcome_unknown"],
  succeeded: [],
  failed: [],
  denied: [],
  cancelled: [],
  outcome_unknown: [],
};

export function receiveToolInvocation(toolCallId: string): ToolInvocationTransition {
  if (toolCallId.length === 0) {
    return { ok: false, code: "invalid_identity" };
  }
  return { ok: true, value: { toolCallId, state: "received" } };
}

export function transitionToolInvocation(
  invocation: ToolInvocation,
  next: ToolInvocationState,
): ToolInvocationTransition {
  if (TERMINAL_STATES.has(invocation.state)) {
    return { ok: false, code: "terminal_outcome_immutable" };
  }
  if (!NEXT_STATES[invocation.state].includes(next)) {
    return { ok: false, code: "invalid_transition" };
  }
  return { ok: true, value: { ...invocation, state: next } };
}
