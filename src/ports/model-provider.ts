export type ProviderToolCall = Readonly<{
  providerToolCallId: string;
  toolName: string;
  arguments: unknown;
}>;

export type ProviderCompletion =
  | Readonly<{
      kind: "completed";
      toolCalls: readonly ProviderToolCall[];
      text: string | null;
    }>
  | Readonly<{ kind: "transient_failure"; safeCode: string; retryAfterMs?: number }>
  | Readonly<{ kind: "authentication_failure"; safeCode: string }>
  | Readonly<{ kind: "invalid_response"; safeCode: string }>;

export type ProviderConversationItem =
  | Readonly<{ kind: "user"; text: string }>
  | Readonly<{
      kind: "tool_result";
      providerToolCallId: string;
      toolName: string;
      status: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";
      text: string | null;
    }>;

export type ProviderRequest = Readonly<{
  modelRequestId: string;
  attemptNo: number;
  conversation: readonly ProviderConversationItem[];
}>;

export interface ModelProvider {
  complete(request: ProviderRequest): Promise<ProviderCompletion>;
}
