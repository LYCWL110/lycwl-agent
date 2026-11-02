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
}>;

export type ToolExecutionResult =
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
    }>;

export interface ToolExecutor {
  getDefinition(toolName: string): ToolDefinition | null;
  /**
   * Optional operation-specific preview bound to the validated invocation.
   * It must not conceal or alter targets, arguments or permission scope, and
   * sensitive values must be redacted. Returning null keeps the caller's
   * generic preview.
   */
  preview?(request: ToolExecutionRequest): Promise<string | null>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
