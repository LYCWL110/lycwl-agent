/**
 * Provider-neutral history and route-bound private data
 * (V1_BEHAVIOR_CONTRACTS section 8).
 *
 * The authoritative history stays neutral. Vendor extras — reasoning summaries,
 * signatures, opaque response items — are only valid for the exact routing that
 * produced them, so they are bound to that routing and never migrated into another
 * provider's private slot.
 *
 * This module decides what may be replayed to a given destination. It fabricates
 * nothing: no invented signatures, no re-executed tools, no cross-provider
 * promotion of private data into a system position.
 */
/**
 * Decide whether private blocks may accompany a request to `target`.
 *
 * Three cases are distinct and must not be conflated:
 * - **same route**: private blocks may replay in their original order;
 * - **same provider, different credential identity**: the block belongs to an
 *   identity, so it is not replayed;
 * - **different provider**: no private block migrates; only neutral content goes.
 *
 * A signature or opaque item the vendor did not actually return is never
 * replayed, because replaying invented vendor data would be forgery.
 */
export function decidePrivateReplay(input) {
    const replayable = [];
    const includedSummaries = [];
    for (const block of input.blocks) {
        if (!block.returnedByVendor) {
            return {
                ok: false,
                code: "private_data_not_returned_by_vendor",
                detail: block.attachmentId,
            };
        }
        const sameRoute = routesEqual(block.route, input.target);
        if (sameRoute) {
            if (block.kind === "reasoning_summary") {
                // A visible summary is ordinary sourced material, not authority. It is
                // reported separately so a caller cannot promote it into a system block.
                includedSummaries.push(block);
                continue;
            }
            replayable.push(block);
            continue;
        }
        const sameProviderDifferentIdentity = block.route.providerId === input.target.providerId &&
            block.route.credentialIdentityRevision !== input.target.credentialIdentityRevision;
        if (sameProviderDifferentIdentity) {
            return { ok: false, code: "credential_identity_changed", detail: block.attachmentId };
        }
        // Different provider: signatures and opaque items cannot cross, and replaying
        // them would be forging another vendor's data. If the adapter requires them,
        // the history cannot be rendered legally at all.
        if (!sameRoute && (block.kind === "signature" || block.kind === "opaque_item")) {
            if (input.requiresSignatures) {
                return {
                    ok: false,
                    code: "protocol_history_incompatible",
                    detail: `block ${block.attachmentId} belongs to ${block.route.providerId}`,
                };
            }
        }
    }
    return { ok: true, replayable, includedSummaries };
}
/**
 * Verify that a neutral history is internally consistent before it is rendered.
 *
 * The rule that matters: every `tool_result` must answer a tool call the preceding
 * assistant message actually made. A history that answers a call nobody made, or
 * leaves a call unanswered, is not a legal protocol history, and sending it would
 * either be rejected by the vendor or silently reinterpret intent.
 */
export function validateNeutralHistory(history) {
    const openCalls = new Set();
    for (const item of history) {
        if (item.kind === "user") {
            if (openCalls.size > 0) {
                return {
                    ok: false,
                    code: "unrenderable_history",
                    detail: `user message arrived while ${openCalls.size} tool call(s) were unanswered`,
                };
            }
            continue;
        }
        if (item.kind === "assistant") {
            if (openCalls.size > 0) {
                return {
                    ok: false,
                    code: "unrenderable_history",
                    detail: `assistant message arrived while ${openCalls.size} tool call(s) were unanswered`,
                };
            }
            for (const call of item.toolCalls) {
                if (openCalls.has(call.providerToolCallId)) {
                    return {
                        ok: false,
                        code: "unrenderable_history",
                        detail: `duplicate tool call id ${call.providerToolCallId}`,
                    };
                }
                openCalls.add(call.providerToolCallId);
            }
            continue;
        }
        // tool_result
        if (!openCalls.has(item.providerToolCallId)) {
            return {
                ok: false,
                code: "unrenderable_history",
                detail: `tool result for unknown call ${item.providerToolCallId}`,
            };
        }
        openCalls.delete(item.providerToolCallId);
    }
    if (openCalls.size > 0) {
        return {
            ok: false,
            code: "unrenderable_history",
            detail: `${openCalls.size} tool call(s) have no recorded result`,
        };
    }
    return { ok: true };
}
/**
 * Build the neutral history a new Run may carry when the provider changes.
 *
 * Vendor-visible reasoning summaries are omitted by default: they are narration
 * from another model, and carrying them into a new provider as if they were
 * context quietly imports a different system's claims. Round-tripping this history
 * keeps user text, assistant tool calls and real tool results, which is what a
 * protocol needs to stay legal.
 */
export function crossProviderHistory(history) {
    return [...history];
}
/**
 * A private block may never become approval, completion evidence or Runtime
 * state. This helper exists so a caller asks the question explicitly instead of
 * treating a `PrivateBlock` as an ordinary fact.
 */
export function isAuthorityBearing() {
    return false;
}
function routesEqual(left, right) {
    return (left.providerId === right.providerId &&
        left.protocolId === right.protocolId &&
        left.adapterVersion === right.adapterVersion &&
        left.modelId === right.modelId &&
        left.endpointFingerprint === right.endpointFingerprint &&
        left.credentialIdentityRevision === right.credentialIdentityRevision);
}
