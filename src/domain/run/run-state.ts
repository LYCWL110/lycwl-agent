export const RUN_STATES = ["active", "waiting", "completed", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const WAITING_REASONS = [
  "approval",
  "user_input",
  "configuration",
  "external_dependency",
  "recovery_review",
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export type RunWaiting = Readonly<{
  state: "waiting";
  reason: WaitingReason;
  waitToken: string;
  requestVersion: number;
}>;

export type RunActive = Readonly<{ state: "active" }>;
export type RunTerminal = Readonly<{
  state: "completed" | "failed" | "cancelled";
}>;
export type Run = RunActive | RunWaiting | RunTerminal;

export type RunTransitionErrorCode =
  | "invalid_transition"
  | "invalid_wait"
  | "run_terminal"
  | "wait_not_resolvable";

export type RunTransition =
  | Readonly<{ ok: true; value: Run }>
  | Readonly<{ ok: false; code: RunTransitionErrorCode }>;

const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["completed", "failed", "cancelled"]);

export function isTerminalRun(run: Run): run is RunTerminal {
  return TERMINAL_STATES.has(run.state);
}

export function startRun(): RunActive {
  return { state: "active" };
}

export function waitRun(
  run: Run,
  reason: WaitingReason,
  waitToken: string,
  requestVersion: number,
): RunTransition {
  if (isTerminalRun(run)) {
    return { ok: false, code: "run_terminal" };
  }
  if (waitToken.length === 0 || !Number.isSafeInteger(requestVersion) || requestVersion < 1) {
    return { ok: false, code: "invalid_wait" };
  }
  return {
    ok: true,
    value: { state: "waiting", reason, waitToken, requestVersion },
  };
}

export function resumeRun(run: Run): RunTransition {
  if (isTerminalRun(run)) {
    return { ok: false, code: "run_terminal" };
  }
  if (run.state !== "waiting") {
    return { ok: false, code: "invalid_transition" };
  }
  return { ok: true, value: { state: "active" } };
}

export function finishRun(run: Run, terminal: RunTerminal["state"]): RunTransition {
  if (isTerminalRun(run)) {
    return { ok: false, code: "run_terminal" };
  }
  return { ok: true, value: { state: terminal } };
}

export function resolveRunWait(
  run: Run,
  expected: Readonly<{ waitToken: string; requestVersion: number; reason: WaitingReason }>,
): RunTransition {
  if (isTerminalRun(run)) {
    return { ok: false, code: "run_terminal" };
  }
  if (
    run.state !== "waiting" ||
    run.waitToken !== expected.waitToken ||
    run.requestVersion !== expected.requestVersion ||
    run.reason !== expected.reason
  ) {
    return { ok: false, code: "wait_not_resolvable" };
  }
  return { ok: true, value: { state: "active" } };
}
