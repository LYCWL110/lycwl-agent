/**
 * Context capacity arithmetic (V1_CONTRACTS.md C04).
 *
 * These are application policy, not vendor guarantees. Every number here is an
 * estimate carrying the 1.20 conservative factor; measured usage is a separate,
 * later fact. UTF-16 units are not exact token counts.
 *
 * The point of centralising the arithmetic is that the failure modes are
 * explicit: an unknown window is not "assume something reasonable", and an
 * irreducible context is not "drop a constraint to make it fit".
 */

export const CONTEXT_LIMITS = Object.freeze({
  /** W below this is unsupported for the V1 main coding workflow. */
  minWindow: 8_192,
  /** H below this cannot hold enough history to be useful. */
  minHistoryBudget: 1_024,
  /** Minimum output allowance regardless of the computed fraction. */
  minOutput: 1_024,
  /** Conservative estimate factor applied to every token estimate. */
  conservativeFactor: 1.2,
  /** Compact before a request once estimated prompt exceeds this fraction of P. */
  compactionTriggerFraction: 0.8,
  recentShare: 0.6,
  summaryShare: 0.4,
});

export type ContextFailure =
  | "model_context_unknown"
  | "context_window_too_small"
  | "context_capacity_insufficient"
  | "invalid_output_limit";

export type ContextBudget = Readonly<{
  /** Verified model context window, capped by a smaller user safety limit. */
  window: number;
  /** Output allowance. */
  output: number;
  /** Safety gap. */
  gap: number;
  /** Total prompt budget: window - output - gap. */
  promptBudget: number;
  /** Incompressible instructions, tool schemas, pinned facts, current task. */
  fixed: number;
  /** History and summary budget: promptBudget - fixed. */
  historyBudget: number;
  recentBudget: number;
  summaryBudget: number;
  /** Prompt size at which compaction should run before sending. */
  compactionTrigger: number;
}>;

export type ContextBudgetResult =
  | Readonly<{ ok: true; value: ContextBudget; estimated: true; conservativeFactor: number }>
  | Readonly<{ ok: false; code: ContextFailure }>;

/**
 * Compute the C04 budget.
 *
 * `window` must be a verified value. Passing `null` is the explicit "unknown
 * window" case and returns `model_context_unknown` rather than guessing.
 */
export function computeContextBudget(input: {
  window: number | null;
  modelMaxOutput: number;
  userMaxOutput: number;
  fixed: number;
}): ContextBudgetResult {
  if (input.window === null) return { ok: false, code: "model_context_unknown" };
  const window = input.window;
  if (!Number.isSafeInteger(window) || window < CONTEXT_LIMITS.minWindow) {
    return { ok: false, code: "context_window_too_small" };
  }
  for (const value of [input.modelMaxOutput, input.userMaxOutput, input.fixed]) {
    if (!Number.isSafeInteger(value) || value < 0)
      return { ok: false, code: "invalid_output_limit" };
  }

  const output = Math.min(
    input.userMaxOutput,
    input.modelMaxOutput,
    Math.max(CONTEXT_LIMITS.minOutput, Math.floor(0.2 * window)),
  );
  if (output <= 0) return { ok: false, code: "invalid_output_limit" };

  const gap = Math.max(512, Math.ceil(0.05 * window));
  const promptBudget = window - output - gap;
  if (promptBudget <= 0) return { ok: false, code: "context_capacity_insufficient" };

  const historyBudget = promptBudget - input.fixed;
  // Never remove mandatory safety constraints to fit. An irreducible fixed part
  // is a capacity failure, not an invitation to trim rules.
  if (historyBudget < CONTEXT_LIMITS.minHistoryBudget) {
    return { ok: false, code: "context_capacity_insufficient" };
  }

  return {
    ok: true,
    estimated: true,
    conservativeFactor: CONTEXT_LIMITS.conservativeFactor,
    value: {
      window,
      output,
      gap,
      promptBudget,
      fixed: input.fixed,
      historyBudget,
      recentBudget: Math.ceil(CONTEXT_LIMITS.recentShare * historyBudget),
      summaryBudget: Math.floor(CONTEXT_LIMITS.summaryShare * historyBudget),
      compactionTrigger: Math.floor(CONTEXT_LIMITS.compactionTriggerFraction * promptBudget),
    },
  };
}

/** Apply the conservative factor to a raw estimate before comparing it to a budget. */
export function conservativeEstimate(rawTokens: number): number {
  if (!Number.isFinite(rawTokens) || rawTokens < 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(rawTokens * CONTEXT_LIMITS.conservativeFactor);
}

export type RequestFit =
  | Readonly<{ outcome: "send"; promptSize: number; compactedAlready: boolean }>
  | Readonly<{ outcome: "compact_first"; promptSize: number }>
  | Readonly<{ outcome: "cannot_send"; reason: "over_budget"; promptSize: number }>;

/**
 * Decide whether a request may be sent or must be compacted first.
 *
 * Above the trigger but still within P, an irreducible context **may be sent**:
 * the 80% trigger is an optimisation, not a hard limit. Only exceeding P blocks
 * sending, and then it blocks unconditionally rather than looping.
 */
export function decideRequestFit(input: {
  budget: ContextBudget;
  promptSize: number;
  historyIsReducible: boolean;
}): RequestFit {
  const { promptSize, budget } = input;
  if (promptSize > budget.promptBudget) {
    return { outcome: "cannot_send", reason: "over_budget", promptSize };
  }
  if (promptSize > budget.compactionTrigger && input.historyIsReducible) {
    return { outcome: "compact_first", promptSize };
  }
  return { outcome: "send", promptSize, compactedAlready: promptSize > budget.compactionTrigger };
}
