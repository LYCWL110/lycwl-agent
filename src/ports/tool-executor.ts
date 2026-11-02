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
  | Readonly<{ status: "outcome_unknown"; safeCode: string }>;

export interface ToolExecutor {
  getDefinition(toolName: string): ToolDefinition | null;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
