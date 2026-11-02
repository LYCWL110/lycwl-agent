import { beginModelRequest } from "../../domain/model-request/model-request-state.ts";
import type {
  ModelProvider,
  ProviderConversationItem,
  ProviderToolCall,
} from "../../ports/model-provider.ts";

export type ModelAttemptOutcome =
  | Readonly<{
      kind: "completed";
      attemptNo: number;
      toolCalls: readonly ProviderToolCall[];
      text: string | null;
    }>
  | Readonly<{ kind: "authentication_failure"; safeCode: string }>
  | Readonly<{ kind: "invalid_response"; safeCode: string }>
  | Readonly<{ kind: "transient_retries_exhausted"; safeCode: string }>;

export type ModelAttemptDependencies = Readonly<{
  provider: ModelProvider;
  sleep: (delayMs: number) => Promise<void>;
  onRequestStarted: (modelRequestId: string, attemptNo: number) => Promise<void>;
  onRetryScheduled: (input: {
    modelRequestId: string;
    failedAttemptNo: number;
    retryAfterMs: number;
    safeCode: string;
  }) => Promise<void>;
}>;

const MAX_TRANSIENT_RETRIES = 2;

export async function completeWithBoundedRetries(
  dependencies: ModelAttemptDependencies,
  modelRequestId: string,
  conversation: readonly ProviderConversationItem[],
): Promise<ModelAttemptOutcome> {
  for (let attemptNo = 1; attemptNo <= MAX_TRANSIENT_RETRIES + 1; attemptNo += 1) {
    const request = beginModelRequest(modelRequestId, attemptNo);
    if (!request.ok) {
      return { kind: "invalid_response", safeCode: request.code };
    }
    await dependencies.onRequestStarted(modelRequestId, attemptNo);
    const completion = await dependencies.provider.complete({
      modelRequestId,
      attemptNo,
      conversation,
    });

    if (completion.kind === "completed") {
      return {
        kind: "completed",
        attemptNo,
        toolCalls: completion.toolCalls,
        text: completion.text,
      };
    }
    if (completion.kind === "authentication_failure") {
      return { kind: "authentication_failure", safeCode: completion.safeCode };
    }
    if (completion.kind === "invalid_response") {
      return { kind: "invalid_response", safeCode: completion.safeCode };
    }

    if (attemptNo > MAX_TRANSIENT_RETRIES) {
      return { kind: "transient_retries_exhausted", safeCode: completion.safeCode };
    }

    const retryAfterMs = Math.max(0, completion.retryAfterMs ?? 0);
    await dependencies.onRetryScheduled({
      modelRequestId,
      failedAttemptNo: attemptNo,
      retryAfterMs,
      safeCode: completion.safeCode,
    });
    if (retryAfterMs > 0) await dependencies.sleep(retryAfterMs);
  }

  return { kind: "invalid_response", safeCode: "attempt_limit" };
}
