import { beginModelRequest } from "../../domain/model-request/model-request-state.js";
const MAX_TRANSIENT_RETRIES = 2;
export async function completeWithBoundedRetries(dependencies, modelRequestId, conversation) {
    const limit = dependencies.attemptLimit ?? MAX_TRANSIENT_RETRIES + 1;
    for (let attemptNo = dependencies.attemptStart ?? 1; attemptNo <= limit; attemptNo += 1) {
        if (dependencies.signal?.aborted)
            return cancelled();
        // A retry starts a fresh display, so text from the failed attempt is not
        // mistaken for part of the new response. Clearing before the pre-send checks
        // also removes stale text while a disclosure or credential check is waiting.
        dependencies.onAttemptStarted?.();
        const request = beginModelRequest(modelRequestId, attemptNo);
        if (!request.ok) {
            return { kind: "invalid_response", safeCode: request.code };
        }
        // C03: bind the credential revision at the next not-yet-sent attempt. A
        // resolver failure must not silently send with an unknown identity, so a
        // throwing resolver is treated as an invalid response.
        let credentialRevision = null;
        if (dependencies.resolveCredentialRevision !== undefined) {
            try {
                credentialRevision = await dependencies.resolveCredentialRevision();
            }
            catch {
                return { kind: "invalid_response", safeCode: "credential_binding_failed" };
            }
        }
        if (dependencies.signal?.aborted)
            return cancelled();
        const started = await dependencies.onRequestStarted(modelRequestId, attemptNo, credentialRevision);
        if (dependencies.signal?.aborted)
            return cancelled();
        if (!started.ok) {
            // A refused pre-send check is not a transient failure: nothing was sent.
            return { kind: "invalid_response", safeCode: started.safeCode };
        }
        const providerRequest = {
            modelRequestId,
            attemptNo,
            // Snapshot the conversation: the Run keeps appending to its own array, and a
            // provider that held the live reference would observe later turns inside a
            // request it already sent. A retry must also see exactly what was sent.
            conversation: [...conversation],
            ...(dependencies.tools === undefined ? {} : { tools: dependencies.tools }),
            ...(dependencies.compaction === undefined ? {} : { compaction: dependencies.compaction }),
            ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        };
        const provider = dependencies.provider;
        const completion = await untilAborted(dependencies.onDelta !== undefined && provider.stream !== undefined
            ? provider.stream(providerRequest, (delta) => {
                if (dependencies.signal?.aborted)
                    return;
                dependencies.onDelta?.(delta);
            })
            : provider.complete(providerRequest), dependencies.signal);
        if (completion === null || dependencies.signal?.aborted)
            return cancelled();
        if (completion.kind === "cancelled")
            return completion;
        if (completion.kind === "completed") {
            return {
                kind: "completed",
                attemptNo,
                toolCalls: completion.toolCalls,
                text: completion.text,
                ...(completion.usage === undefined ? {} : { usage: completion.usage }),
            };
        }
        if (completion.kind === "authentication_failure") {
            return { kind: "authentication_failure", safeCode: completion.safeCode };
        }
        if (completion.kind === "invalid_response") {
            return { kind: "invalid_response", safeCode: completion.safeCode };
        }
        if (attemptNo >= limit) {
            return { kind: "transient_retries_exhausted", safeCode: completion.safeCode };
        }
        const retryAfterMs = Math.max(0, completion.retryAfterMs ?? 0);
        await dependencies.onRetryScheduled({
            modelRequestId,
            failedAttemptNo: attemptNo,
            retryAfterMs,
            safeCode: completion.safeCode,
        });
        if (dependencies.signal?.aborted)
            return cancelled();
        if (retryAfterMs > 0) {
            await untilAborted(dependencies.sleep(retryAfterMs, dependencies.signal), dependencies.signal);
        }
    }
    return { kind: "invalid_response", safeCode: "attempt_limit" };
}
function cancelled() {
    return { kind: "cancelled", safeCode: "model_request_cancelled" };
}
/** Late completions from adapters that ignore the signal cannot resume the Run. */
async function untilAborted(operation, signal) {
    if (signal === undefined)
        return operation;
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            resolve(null);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
        operation.then((value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}
