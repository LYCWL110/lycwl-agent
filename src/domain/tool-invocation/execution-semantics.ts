/**
 * Tool execution semantics: whether an operation may be retried, and how an
 * uncertain outcome is resolved.
 *
 * Two facts are needed that `sideEffectClass` alone does not carry:
 *
 * 1. **Idempotent** — repeating the call produces the same state. A read is
 *    idempotent; a payment is not. The distinction decides whether a transient
 *    failure may be retried automatically. It must be declared by the adapter that
 *    knows the operation, never inferred from the name or from a model claim.
 *
 * 2. **Verification** — how to establish what happened after `outcome_unknown`.
 *    A timeout does not prove the operation failed; the process may have run and
 *    its result may have been lost. Guessing either way is wrong: assuming success
 *    reports a state that was never observed, and assuming failure invites a retry
 *    that duplicates a side effect.
 *
 * Verification is a capability of the executor rather than data, because only the
 * adapter knows how to inspect its own effect. A data-driven probe that re-invoked
 * a tool would re-run the operation, which is the exact mistake this exists to
 * prevent.
 */

export type ToolRetryPolicy = "never" | "safe" | "conditional";

export type ToolExecutionSemantics = Readonly<{
  /**
   * Repeating this exact call produces the same state.
   *
   * A non-idempotent operation is never retried automatically, and its
   * `outcome_unknown` is never resolved by re-running it.
   */
  idempotent: boolean;
  /**
   * Whether a transient failure may be retried.
   *
   * `safe` requires `idempotent`. `conditional` means the adapter decides per
   * invocation; this module does not guess which way.
   */
  retry: ToolRetryPolicy;
}>;

/** What a verification attempt established. */
export type VerificationVerdict =
  /** The effect is confirmed present. */
  | "applied"
  /** The effect is confirmed absent. */
  | "not_applied"
  /**
   * The check ran but does not settle the question.
   *
   * This is a real answer, not a failure: reporting either verdict from an
   * inconclusive check would be a fabricated fact.
   */
  | "inconclusive";

/**
 * Default semantics by side-effect class.
 *
 * These are the conservative values: a class whose operations are sometimes
 * idempotent and sometimes not is treated as not idempotent, because assuming
 * idempotence is the mistake that duplicates a side effect.
 */
export function defaultSemantics(
  sideEffectClass: "read_only" | "filesystem_mutation" | "process_execution" | "external_request",
): ToolExecutionSemantics {
  switch (sideEffectClass) {
    case "read_only":
      // Reads change nothing, so a repeat is harmless.
      return { idempotent: true, retry: "safe" };
    case "filesystem_mutation":
      // A mutation that already happened leaves the same state on a repeat, so the
      // operation is idempotent in effect even though the second call may fail.
      return { idempotent: true, retry: "conditional" };
    case "process_execution":
      // A command can do anything, including things that must not happen twice.
      return { idempotent: false, retry: "never" };
    case "external_request":
      // A request may have been received even when the response was lost.
      return { idempotent: false, retry: "never" };
  }
}

/** Whether an automatic retry is permitted. */
export function mayRetryAutomatically(semantics: ToolExecutionSemantics): boolean {
  if (semantics.retry === "never") return false;
  if (semantics.retry === "safe") return semantics.idempotent;
  // `conditional` defers to the caller, which has the invocation in hand.
  return false;
}

export type UncertaintyResolution =
  | Readonly<{ kind: "applied" }>
  | Readonly<{ kind: "not_applied" }>
  | Readonly<{ kind: "unresolved"; guidance: string }>;

/**
 * Turn a verification verdict into a resolution.
 *
 * A tool with no verifier, or one that answers `inconclusive`, leaves the outcome
 * unknown and reports what the user can check.
 */
export function resolveUncertainty(
  verdict: VerificationVerdict | null,
  guidance: string | undefined,
): UncertaintyResolution {
  if (verdict === "applied") return { kind: "applied" };
  if (verdict === "not_applied") return { kind: "not_applied" };
  return {
    kind: "unresolved",
    guidance: guidance ?? "The outcome could not be verified; inspect the target before retrying.",
  };
}
