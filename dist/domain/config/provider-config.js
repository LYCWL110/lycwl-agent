/**
 * Provider configuration (C03 + S02 first-time setup).
 *
 * This is the model behind the TUI setup screen: which provider, protocol,
 * endpoint, model and credential reference a Run will use. It decides nothing
 * about network access or credentials 閳?it validates a draft and produces the
 * values the composition root needs.
 *
 * Only protocols with an implemented adapter are selectable.
 */
import { isContextWindow } from "./model-context.js";
export const SUPPORTED_PROTOCOLS = [
    "anthropic_messages",
    "openai_chat",
    "openai_responses",
];
export const REASONING_EFFORTS = [
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/** Values representable by each implemented protocol, independent of model support. */
export function protocolReasoningEfforts(protocol) {
    return protocol === "anthropic_messages"
        ? ["default", "low", "medium", "high", "xhigh", "max"]
        : REASONING_EFFORTS;
}
export const PROVIDER_CONFIG_LIMITS = Object.freeze({
    maxModelLength: 200,
    maxBaseUrlLength: 2_048,
    maxCredentialRefLength: 128,
    defaultMaxOutputTokens: 4_096,
});
/**
 * Where the request actually goes, given the protocol.
 *
 * Users routinely paste a base URL that already ends in `/v1`, which is what most
 * provider consoles display. Appending `/v1/...` to that produced `/v1/v1/messages`
 * and a 404, so an existing version segment is respected rather than duplicated.
 */
export function protocolEndpoint(baseUrl, protocol) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    // Treat a trailing /v1 or /v1beta as the version root already being present.
    const base = /\/v1(beta)?$/i.test(trimmed) ? trimmed.replace(/\/v1(beta)?$/i, "") : trimmed;
    if (protocol === "openai_chat")
        return `${base}/v1/chat/completions`;
    if (protocol === "openai_responses")
        return `${base}/v1/responses`;
    return `${base}/v1/messages`;
}
/** Kept for the Anthropic call sites that predate the second protocol. */
export function messagesEndpoint(baseUrl) {
    return protocolEndpoint(baseUrl, "anthropic_messages");
}
/**
 * Validate a draft.
 *
 * A plaintext `http` endpoint is refused. Unlike WebFetch, there is no user
 * confirmation step on this path that could make an unencrypted credential
 * transmission acceptable, and the adapter itself refuses it too.
 */
export function validateProviderConfig(input) {
    if (typeof input.protocol !== "string" || input.protocol.length === 0) {
        return { ok: false, code: "invalid_protocol", field: "protocol" };
    }
    if (!SUPPORTED_PROTOCOLS.includes(input.protocol)) {
        // Not "unknown protocol": this build genuinely cannot serve it.
        return { ok: false, code: "unsupported_protocol", field: "protocol" };
    }
    if (input.reasoningEffort !== undefined &&
        (typeof input.reasoningEffort !== "string" ||
            !protocolReasoningEfforts(input.protocol).includes(input.reasoningEffort))) {
        return { ok: false, code: "invalid_reasoning_effort", field: "reasoningEffort" };
    }
    if (typeof input.baseUrl !== "string" || input.baseUrl.length === 0) {
        return { ok: false, code: "missing_field", field: "baseUrl" };
    }
    if (input.baseUrl.length > PROVIDER_CONFIG_LIMITS.maxBaseUrlLength) {
        return { ok: false, code: "invalid_base_url", field: "baseUrl" };
    }
    let parsed;
    try {
        parsed = new URL(input.baseUrl);
    }
    catch {
        return { ok: false, code: "invalid_base_url", field: "baseUrl" };
    }
    if (parsed.protocol !== "https:") {
        return { ok: false, code: "insecure_base_url", field: "baseUrl" };
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        return { ok: false, code: "invalid_base_url", field: "baseUrl" };
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
        // A query or fragment on a base URL would be dropped when the path is
        // appended, so accepting it would silently send a different endpoint.
        return { ok: false, code: "invalid_base_url", field: "baseUrl" };
    }
    if (typeof input.model !== "string" || input.model.trim().length === 0) {
        return { ok: false, code: "invalid_model", field: "model" };
    }
    if (input.model.length > PROVIDER_CONFIG_LIMITS.maxModelLength) {
        return { ok: false, code: "invalid_model", field: "model" };
    }
    if (typeof input.credentialRef !== "string" || input.credentialRef.length === 0) {
        return { ok: false, code: "missing_field", field: "credentialRef" };
    }
    if (input.credentialRef.length > PROVIDER_CONFIG_LIMITS.maxCredentialRefLength ||
        !/^[\x21-\x7e]+$/.test(input.credentialRef)) {
        return { ok: false, code: "invalid_credential_ref", field: "credentialRef" };
    }
    // Preserve legacy nulls in storage; the runtime supplies the product default.
    const rawWindow = input.contextWindow;
    if (input.contextWindowSource !== undefined &&
        !["upstream", "manual", "default"].includes(input.contextWindowSource))
        return { ok: false, code: "invalid_context_window", field: "contextWindow" };
    let contextWindow = null;
    if (rawWindow !== undefined && rawWindow !== null) {
        if (!isContextWindow(rawWindow)) {
            return { ok: false, code: "invalid_context_window", field: "contextWindow" };
        }
        contextWindow = rawWindow;
    }
    const rawTokens = input.maxOutputTokens;
    const maxOutputTokens = rawTokens === undefined ? PROVIDER_CONFIG_LIMITS.defaultMaxOutputTokens : rawTokens;
    if (typeof maxOutputTokens !== "number" ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > 64_000) {
        return { ok: false, code: "invalid_output_tokens", field: "maxOutputTokens" };
    }
    return {
        ok: true,
        value: {
            protocol: input.protocol,
            baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ""),
            model: input.model.trim(),
            credentialRef: input.credentialRef,
            maxOutputTokens,
            contextWindow,
            ...(input.contextWindowSource === undefined
                ? {}
                : { contextWindowSource: input.contextWindowSource }),
            ...(input.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: input.reasoningEffort }),
        },
    };
}
/**
 * Read a ProviderConfig out of a parsed settings document.
 *
 * Returns a typed failure rather than throwing, so the TUI can show a specific
 * message and the entry point can fall back to the demo instead of crashing.
 */
export function readProviderConfig(settings) {
    if (typeof settings !== "object" || settings === null) {
        return { ok: false, code: "missing_field", field: "provider" };
    }
    const provider = settings["provider"];
    if (typeof provider !== "object" || provider === null) {
        return { ok: false, code: "missing_field", field: "provider" };
    }
    const record = provider;
    return validateProviderConfig({
        protocol: record["protocol"],
        baseUrl: record["baseUrl"],
        model: record["model"],
        credentialRef: record["credentialRef"],
        maxOutputTokens: record["maxOutputTokens"],
        contextWindow: record["contextWindow"],
        contextWindowSource: record["contextWindowSource"],
        reasoningEffort: record["reasoningEffort"],
    });
}
/** Mask a secret for display: never show any character of it. */
export function maskSecret(value) {
    if (value.length === 0)
        return "(empty)";
    // A fixed-width mask, not a length hint: surviving characters could be the only
    // distinguishing part of a short key.
    return "********";
}
