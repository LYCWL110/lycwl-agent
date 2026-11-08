import type { ToolEvidence } from "../domain/evidence/tool-evidence.ts";
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
  discardApproval?(toolCallId: string): void;
  cancelAll?(): Promise<void>;
  observeBackground?(observer: BackgroundObserver): () => void;
  flushBackground?(): Promise<void>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
