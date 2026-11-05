/**
 * No-progress detection (V1_BEHAVIOR_CONTRACTS section 7).
 *
 * This detects a stuck loop; it never grants a new budget. The hard caps in C04/C05
 * still apply, and detection cannot widen an approval, retry an operation with an
 * unknown outcome, or replay a side effect. Its only powers are: emit a structured
 * warning, or stop before dispatch and enter `waiting(recovery_review)`.
 *
 * Two independent detectors exist:
 *
 * 1. **Call fingerprints** — the same tool, version, normalized input and unchanged
 *    relevant resource: warn after the second identical result, block before the
 *    third.
 * 2. **Recovery-path failures** — equivalent failures along the same recovery
 *    path: warn after three, wait after five. This is cross-call, and it does not
 *    permit one logical request to exceed its own three-attempt cap.
 *
 * A model claiming "progress" in prose does not reset either counter. Neither does
 * compaction or regenerating ids. If that were not true, a model could clear its
 * own stall by talking.
 */

export const NO_PROGRESS_LIMITS = Object.freeze({
  /** Identical successful calls allowed before a warning, then before blocking. */
  identicalWarnAt: 2,
  identicalBlockBefore: 3,
  /** Equivalent consecutive failures along one recovery path. */
  failureWarnAt: 3,
  failureWaitAt: 5,
  /** Model stream: time to the first effective event. */
  firstEffectiveEventMs: 90_000,
  /** Model stream: idle time with no effective content after that. */
  idleAfterEffectiveEventMs: 60_000,
  /** The existing attempt cap. Detection never extends it. */
  attemptCapMs: 180_000,
});

export type FailureCategory =
  | "transient"
  | "authentication"
  | "invalid_request"
  | "tool_failure"
  | "timeout"
  | "outcome_unknown";

/**
 * Structured failure identity. Free-form error text is deliberately absent: it
 * varies between identical failures and would make every failure look different,
 * which defeats the whole comparison.
 */
export type FailureFingerprint = Readonly<{
  category: FailureCategory;
  code: string;
  stage: string;
}>;

/**
 * A call fingerprint.
 *
 * `resourceVersion` is a content hash or version of the resources the call read or
 * targeted. It is what distinguishes "re-reading a file that changed" from
 * "re-reading an unchanged file", so a legitimate repeat is not flagged.
 */
export type CallFingerprint = Readonly<{
  toolName: string;
  toolVersion: string;
  /** Canonicalized input. Callers normalize key order before calling. */
  normalizedInput: string;
  resourceVersion: string | null;
}>;

export type CallRecord = Readonly<{
  fingerprint: CallFingerprint;
  /** Tool status from the recorded result. */
  status: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";
  failure: FailureFingerprint | null;
}>;

export type ProgressDecision =
  | Readonly<{ kind: "proceed" }>
  | Readonly<{ kind: "warn"; reason: "no_progress"; detail: string }>
  | Readonly<{
      kind: "block";
      reason: "no_progress";
      detail: string;
      /** Dispatching this call must not happen. */
      blockedToolName: string;
    }>;

/**
 * Decide whether an identical call may be dispatched.
 *
 * Only *identical* calls with an *unchanged* resource count. A changed resource
 * version, new user input or a different normalized input is progress and resets
 * the run of identical records for that fingerprint.
 */
export function checkIdenticalCall(input: {
  fingerprint: CallFingerprint;
  /** Every recorded call in the Run, oldest first. */
  history: readonly CallRecord[];
  /** True when new user input arrived since the last identical call. */
  hasNewUserInput: boolean;
}): ProgressDecision {
  if (input.hasNewUserInput) return { kind: "proceed" };

  const identical = input.history.filter((record) =>
    fingerprintsEqual(record.fingerprint, input.fingerprint),
  );
  const count = identical.length;

  if (count >= NO_PROGRESS_LIMITS.identicalBlockBefore - 1) {
    // The next call would be the Nth identical one: block before dispatch.
    return {
      kind: "block",
      reason: "no_progress",
      detail: `identical call already recorded ${count} time(s); awaiting recovery review`,
      blockedToolName: input.fingerprint.toolName,
    };
  }
  if (count >= NO_PROGRESS_LIMITS.identicalWarnAt - 1) {
    return {
      kind: "warn",
      reason: "no_progress",
      detail: `identical call recorded ${count} time(s)`,
    };
  }
  return { kind: "proceed" };
}

/**
 * A background status poll is progress when it observes new output of a task that
 * is still running. Polling such a task is explicitly not "the same arguments with
 * no change", so it must not be counted as a stall — but it also does not exempt
 * the task or Run from their own time limits.
 */
export function isObservedBackgroundPoll(input: {
  toolName: string;
  taskStillRunning: boolean;
  observedNewOutput: boolean;
}): boolean {
  if (!input.toolName.startsWith("background_")) return false;
  return input.taskStillRunning && input.observedNewOutput;
}

export type RecoveryDecision =
  | Readonly<{ kind: "proceed" }>
  | Readonly<{ kind: "warn"; reason: "equivalent_failures"; detail: string }>
  | Readonly<{ kind: "wait"; reason: "recovery_review"; detail: string }>;

/**
 * Track equivalent consecutive failures along one recovery path.
 *
 * `pathId` identifies the recovery path, so failures in different areas do not
 * accumulate against each other. A success, or any change of path, ends the run.
 */
export function checkRecoveryFailures(input: {
  pathId: string;
  failure: FailureFingerprint;
  /** Recorded failures with their path and fingerprint, oldest first. */
  history: readonly Readonly<{ pathId: string; failure: FailureFingerprint }>[];
}): RecoveryDecision {
  // Count the trailing run on this path with this exact failure identity.
  let consecutive = 0;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const record = input.history[index];
    if (record === undefined) break;
    if (record.pathId !== input.pathId) break;
    if (!failuresEqual(record.failure, input.failure)) break;
    consecutive += 1;
  }
  const next = consecutive + 1;

  if (next >= NO_PROGRESS_LIMITS.failureWaitAt) {
    return {
      kind: "wait",
      reason: "recovery_review",
      detail: `${next} equivalent failures on path ${input.pathId}`,
    };
  }
  if (next >= NO_PROGRESS_LIMITS.failureWarnAt) {
    return {
      kind: "warn",
      reason: "equivalent_failures",
      detail: `${next} equivalent failures on path ${input.pathId}`,
    };
  }
  return { kind: "proceed" };
}

export type StreamEventKind =
  /** A typed event that carries real content: text delta, tool argument delta. */
  | "effective"
  /** Bytes, SSE heartbeat, usage-only or a repeated empty delta. */
  | "heartbeat";

export type StreamProgressVerdict =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "abort"; reason: "first_event_timeout" | "idle_timeout"; elapsedMs: number }>;

/**
 * Evaluate a model stream against the two clocks.
 *
 * The first clock measures time to the first *effective* event. After that, the
 * idle clock measures time without effective content. Heartbeats, usage-only
 * events and repeated empty deltas refresh neither clock, because a vendor that
 * keeps the socket warm is not making progress.
 *
 * The result only routes into the existing transient-retry path; it never extends
 * the 180s attempt cap and never dispatches a tool from an incomplete response.
 */
export function evaluateStreamProgress(input: {
  /** Milliseconds since the attempt started. */
  elapsedMs: number;
  /** Milliseconds since the last effective event, or since start if none. */
  sinceEffectiveMs: number;
  sawEffectiveEvent: boolean;
}): StreamProgressVerdict {
  if (input.elapsedMs >= NO_PROGRESS_LIMITS.attemptCapMs) {
    // The existing cap owns this case; the caller's normal timeout applies.
    return { kind: "continue" };
  }
  if (!input.sawEffectiveEvent) {
    // The first-event clock can never exceed the attempt cap, so a slow-but-alive
    // stream inside the cap is not aborted by this rule.
    if (input.elapsedMs >= NO_PROGRESS_LIMITS.firstEffectiveEventMs) {
      return {
        kind: "abort",
        reason: "first_event_timeout",
        elapsedMs: input.elapsedMs,
      };
    }
    return { kind: "continue" };
  }
  if (input.sinceEffectiveMs >= NO_PROGRESS_LIMITS.idleAfterEffectiveEventMs) {
    return { kind: "abort", reason: "idle_timeout", elapsedMs: input.sinceEffectiveMs };
  }
  return { kind: "continue" };
}

/**
 * Classify a stream event. Only content-bearing deltas count as progress.
 * `usage` and `heartbeat` exist so an adapter cannot accidentally treat them as
 * progress by omission.
 */
export function classifyStreamEvent(event: {
  kind: "text_delta" | "tool_argument_delta" | "heartbeat" | "usage" | "empty_delta";
  hasContent: boolean;
}): StreamEventKind {
  if (event.kind === "text_delta" || event.kind === "tool_argument_delta") {
    return event.hasContent ? "effective" : "heartbeat";
  }
  return "heartbeat";
}

/**
 * Resume after an explicit user recovery decision starts a new detection window
 * for the same failure, while the accumulated history and consumed budget are
 * kept. This does not permanently exempt the failure: reaching the threshold again
 * waits again.
 */
export function resumeDetectionWindow(input: {
  history: readonly Readonly<{ pathId: string; failure: FailureFingerprint }>[];
  pathId: string;
  failure: FailureFingerprint;
}): Readonly<{ history: readonly Readonly<{ pathId: string; failure: FailureFingerprint }>[] }> {
  // Append a boundary marker by inserting a record on a distinct path id, which
  // ends the trailing run without deleting any history.
  return {
    history: [
      ...input.history,
      { pathId: `resumed:${input.pathId}:${input.history.length}`, failure: input.failure },
    ],
  };
}

function fingerprintsEqual(left: CallFingerprint, right: CallFingerprint): boolean {
  return (
    left.toolName === right.toolName &&
    left.toolVersion === right.toolVersion &&
    left.normalizedInput === right.normalizedInput &&
    left.resourceVersion === right.resourceVersion
  );
}

function failuresEqual(left: FailureFingerprint, right: FailureFingerprint): boolean {
  return left.category === right.category && left.code === right.code && left.stage === right.stage;
}
