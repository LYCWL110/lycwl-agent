export type ProviderToolCall = Readonly<{
  providerToolCallId: string;
  toolName: string;
  arguments: unknown;
}>;

export type ProviderCompletion =
  | Readonly<{ kind: "cancelled"; safeCode: string }>
  | Readonly<{
      kind: "completed";
      toolCalls: readonly ProviderToolCall[];
      text: string | null;
      /**
       * Token counts the provider reported for this request.
       *
       * Absent when the provider did not report them or the adapter could not read
       * them. Absent is not zero: a missing count means the cost is unknown, and
       * treating it as zero would make a Run look free when it was not.
       */
      usage?: TokenUsage;
    }>
  | Readonly<{ kind: "transient_failure"; safeCode: string; retryAfterMs?: number }>
  | Readonly<{ kind: "authentication_failure"; safeCode: string }>
  | Readonly<{ kind: "invalid_response"; safeCode: string }>;

/**
 * Token usage for one logical request.
 *
 * Counts are per request, not cumulative. A Run's total is the sum over its
 * requests, which the coordinator accumulates rather than asking the provider for
 * a running figure it does not track.
 */
export type TokenUsage = Readonly<{
  /** Tokens the provider counted in the prompt, including any cached prefix. */
  inputTokens: number;
  /** Tokens the provider generated, including reasoning where it is billed. */
  outputTokens: number;
  /** Prompt tokens served from the provider's cache, when reported separately. */
  cachedInputTokens?: number;
  /** Reasoning tokens, when the provider reports them separately from output. */
  reasoningTokens?: number;
}>;

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
  signal?: AbortSignal;
  /** Trusted Runtime auxiliary mode; disables tool declarations and caps output. */
  compaction?: Readonly<{ maxOutputTokens: number }>;
}>;

export interface ModelProvider {
  complete(request: ProviderRequest): Promise<ProviderCompletion>;
}
