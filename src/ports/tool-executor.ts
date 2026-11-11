import type { ToolEvidence } from "../domain/evidence/tool-evidence.ts";
import type { ToolExecutionSemantics } from "../domain/tool-invocation/execution-semantics.ts";
import type { ResultCompleteness } from "../domain/tool-invocation/result-completeness.ts";
import type { BackgroundObserver } from "./background-task.ts";

export type ToolSideEffectClass =
  | "read_only"
  | "filesystem_mutation"
  | "process_execution"
  | "external_request";

export type ToolDefinition = Readonly<{
  name: string;
  version: string;
  sideEffectClass: ToolSideEffectClass;
  requiresApproval: boolean;
  concurrencySafe: boolean;
  /**
   * Whether the operation may be retried, and how an uncertain outcome is resolved.
   *
   * Absent falls back to `defaultSemantics(sideEffectClass)`, which is conservative:
   * a class whose operations are sometimes repeatable is treated as not repeatable.
   * A tool that knows better declares it here.
   */
  semantics?: ToolExecutionSemantics;
  /**
   * What to tell the user when an uncertain outcome cannot be resolved.
   *
   * Absent falls back to a generic instruction. The check itself is a method on
   * the executor, because only the adapter knows how to inspect its own effect.
   */
  uncertaintyGuidance?: string;
}>;

export type ToolExecutionRequest = Readonly<{
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
  /** Set only by the coordinator after consuming this invocation's approval. */
  approvalGranted?: boolean;
  /** Coordinator-owned scope; never accepted from tool arguments. */
  owner?: Readonly<{ sessionId: string; runId: string }>;
}>;

export type ToolExecutionResult = Readonly<{
  evidence?: ToolEvidence;
  /**
   * Whether the result is complete, partial or unconfirmed.
   *
   * Absent means complete, which is the common case and keeps existing tools
   * unchanged. A tool that truncates, pages or spills declares it here instead of
   * leaving a marker in the text for the model to notice.
   */
  completeness?: ResultCompleteness;
  /** Early capture protection; preserves execution status and withholds payload. */
  deliveryBlocked?: "owned_key_detected" | "guard_failure";
  /** Trusted adapter provenance, not model-supplied sensitivity labels. */
  sensitiveSources?: readonly Readonly<{
    sourceId: string;
    label: string;
    contentDigest: string;
  }>[];
}> &
  (
    | Readonly<{ status: "succeeded"; text: string | null }>
    | Readonly<{ status: "failed"; safeCode: string; text: string | null }>
    | Readonly<{
        status: "outcome_unknown";
        safeCode: string;
        /**
         * Bounded facts that are already known, such as which batch targets were
         * applied before the unknown one. Never a success claim.
         */
        text?: string | null;
      }>
  );

export interface ToolExecutor {
  getDefinition(toolName: string): ToolDefinition | null;
  /**
   * Optional operation-specific preview bound to the validated invocation.
   * It must not conceal or alter targets, arguments or permission scope, and
   * sensitive values must be redacted. Returning null keeps the caller's
   * generic preview.
   */
  preview?(request: ToolExecutionRequest): Promise<string | null>;
  requiresApproval?(request: ToolExecutionRequest): Promise<boolean>;
  revalidateApproval?(request: ToolExecutionRequest): Promise<boolean>;
  /**
   * Establish what happened after an outcome became unknown.
   *
   * It must not re-run the operation: a verifier that repeats the call is the
   * mistake this exists to prevent. It performs a read-only inspection and returns
   * `applied`, `not_applied`, or `inconclusive`.
   *
   * Absent means the outcome stays unknown, which is a legitimate answer.
   */
  verifyOutcome?(
    request: ToolExecutionRequest,
  ): Promise<import("../domain/tool-invocation/execution-semantics.ts").VerificationVerdict | null>;
  discardApproval?(toolCallId: string): void;
  cancelAll?(): Promise<void>;
  observeBackground?(observer: BackgroundObserver): () => void;
  flushBackground?(): Promise<void>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
