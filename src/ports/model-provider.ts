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

/**
 * Provider-neutral conversation item (V1_BEHAVIOR_CONTRAINTS section 8).
 *
 * The authoritative history records neutral user input, assistant-visible output,
 * normalized tool calls and results, and execution facts. Adapter-private data
 * (reasoning text, signatures, opaque items) never appears here: it lives in a
 * separately bound private block, because it is only valid for the routing that
 * produced it.
 */
export type ProviderConversationItem =
  | Readonly<{ kind: "user"; text: string }>
  | Readonly<{
      kind: "assistant";
      text: string | null;
      /**
       * Tool calls the assistant requested. Present because a protocol history
       * that omitted them would be invalid: the following tool_result items must
       * answer calls the assistant actually made.
       */
      toolCalls: readonly ProviderToolCall[];
    }>
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
