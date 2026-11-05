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
  onRequestStarted: (
    modelRequestId: string,
    attemptNo: number,
    credentialRevision: number | null,
  ) => Promise<
    | Readonly<{ ok: true }>
    /** False stops the request before it is sent; nothing left the process. */
    | Readonly<{ ok: false; safeCode: string }>
  >;
  /**
   * Resolve the credential revision for a new attempt. Called once per attempt so
   * a same-provider rotation applies to the next unsent request rather than being
   * frozen at Run start. Returning null means no credential binding applies.
   */
  resolveCredentialRevision?: () => Promise<number | null>;
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
    // C03: bind the credential revision at the next not-yet-sent attempt. A
    // resolver failure must not silently send with an unknown identity, so a
    // throwing resolver is treated as an invalid response.
    let credentialRevision: number | null = null;
    if (dependencies.resolveCredentialRevision !== undefined) {
      try {
        credentialRevision = await dependencies.resolveCredentialRevision();
      } catch {
        return { kind: "invalid_response", safeCode: "credential_binding_failed" };
      }
    }
    const started = await dependencies.onRequestStarted(
      modelRequestId,
      attemptNo,
      credentialRevision,
    );
    if (!started.ok) {
      // A refused pre-send check is not a transient failure: nothing was sent.
      return { kind: "invalid_response", safeCode: started.safeCode };
    }
    const completion = await dependencies.provider.complete({
      modelRequestId,
      attemptNo,
      // Snapshot the conversation: the Run keeps appending to its own array, and a
      // provider that held the live reference would observe later turns inside a
      // request it already sent. A retry must also see exactly what was sent.
      conversation: [...conversation],
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
