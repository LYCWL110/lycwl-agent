/**
 * Map a transport failure. TLS and connect failures are transient because they are
 * usually network conditions; a bad endpoint is not, because retrying a malformed
 * URL cannot help.
 */
export function transportFailure(code) {
    if (code === "cancelled")
        return { kind: "cancelled", safeCode: "provider_cancelled" };
    if (code === "invalid_endpoint" || code === "request_too_large") {
        return { kind: "invalid_response", safeCode: `provider_${code}` };
    }
    if (code === "invalid_stream") {
        // A malformed SSE frame is a protocol error, not a transient network event.
        return { kind: "invalid_response", safeCode: "provider_invalid_stream" };
    }
    if (code === "response_too_large") {
        // A reply this large is a broken or hostile endpoint, not a slow one.
        return { kind: "invalid_response", safeCode: "provider_response_too_large" };
    }
    return { kind: "transient_failure", safeCode: `provider_${code}` };
}
/** Header-derived retry delay, clamped so a hostile value cannot stall a Run. */
export function parseRetryAfterMs(headers, maxMs = 60_000) {
    const raw = headers["retry-after"];
    if (raw === undefined)
        return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0)
        return undefined;
    return Math.min(Math.floor(seconds * 1000), maxMs);
}
/**
 * Classify a non-2xx status.
 *
 * `safeCode` names the category rather than echoing the vendor's message: free
 * text from a Provider is untrusted input and must not become a diagnostic code.
 */
export function classifyHttpStatus(status, headers, providerLabel) {
    if (status >= 200 && status < 300)
        return null;
    if (status === 401 || status === 403) {
        return { kind: "authentication_failure", safeCode: `${providerLabel}_unauthorized` };
    }
    if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(headers);
        return {
            kind: "transient_failure",
            safeCode: `${providerLabel}_rate_limited`,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
    }
    if (status >= 500) {
        return { kind: "transient_failure", safeCode: `${providerLabel}_server_error` };
    }
    if (status >= 300 && status < 400) {
        // Redirects are never followed on a credential-bearing request.
        return { kind: "invalid_response", safeCode: `${providerLabel}_unexpected_redirect` };
    }
    // Other 4xx: the request itself is wrong, so retrying sends the same wrong request.
    return { kind: "invalid_response", safeCode: `${providerLabel}_request_rejected` };
}
export function parseJsonBody(bodyText) {
    try {
        return { ok: true, value: JSON.parse(bodyText) };
    }
    catch {
        return { ok: false, code: "not_json" };
    }
}
/** Read a required string field without trusting the payload shape. */
export function requireString(record, key) {
    const value = record[key];
    return typeof value === "string" ? { ok: true, value } : { ok: false };
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
