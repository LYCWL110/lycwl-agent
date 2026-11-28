import { request as httpsRequest } from "node:https";
import { pinnedLookup, resolveWebFetchHost } from "../windows/dns-resolver.js";
/**
 * Tavily search adapter (ADR-0023).
 *
 * The Harness performs the call itself, so the exact-query approval contract and
 * the C07 quota ledger still apply. Search is never delegated to the model
 * provider, and there is no fallback to another vendor.
 *
 * Only a configuration identity and a credential reference are accepted here;
 * the key value is resolved by the credential boundary and never logged.
 */
export const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Perform one search. A failure that may have reached the vendor is returned as
 * `request_failed`; the caller records an uncertain charge and never retries.
 *
 * The key is passed in already resolved by the credential boundary, so the same
 * value that authorized the quota reservation is the value that is sent. It is
 * never read from the environment, logged, or placed in an event.
 */
export async function tavilySearch(request, apiKey) {
    if (apiKey.length === 0)
        return { ok: false, code: "not_configured" };
    const host = new URL(TAVILY_ENDPOINT).hostname;
    const resolved = await resolveWebFetchHost(host);
    if (!resolved.ok)
        return { ok: false, code: "request_failed" };
    const body = JSON.stringify({
        query: request.query,
        max_results: request.count,
        search_depth: request.searchDepth ?? "basic",
        ...(request.topic === undefined ? {} : { topic: request.topic }),
    });
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish({ ok: false, code: "request_failed" });
            req.destroy();
        }, 30_000);
        timer.unref?.();
        const req = httpsRequest({
            method: "POST",
            host,
            path: "/search",
            headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                authorization: `Bearer ${apiKey}`,
                // Harness-managed; the model never supplies a User-Agent.
                "user-agent": "lycwl-agent/0.1",
            },
            lookup: pinnedLookup(resolved.addresses.map((entry) => entry.address)),
        }, (response) => {
            let received = 0;
            const chunks = [];
            response.on("data", (chunk) => {
                received += chunk.length;
                if (received > MAX_RESPONSE_BYTES) {
                    finish({ ok: false, code: "invalid_response" });
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                const status = response.statusCode ?? 0;
                if (status === 401 || status === 403) {
                    finish({ ok: false, code: "authentication_failed" });
                    return;
                }
                if (status === 429) {
                    // Ambiguous between rate limiting and quota exhaustion; both are
                    // non-retryable here because the caller must not auto-resend.
                    finish({ ok: false, code: "rate_limited" });
                    return;
                }
                if (status === 432 || status === 433) {
                    finish({ ok: false, code: "quota_exhausted" });
                    return;
                }
                if (status !== 200) {
                    finish({ ok: false, code: "request_failed" });
                    return;
                }
                let payload;
                try {
                    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                }
                catch {
                    finish({ ok: false, code: "invalid_response" });
                    return;
                }
                if (!Array.isArray(payload.results)) {
                    finish({ ok: false, code: "invalid_response" });
                    return;
                }
                const items = [];
                for (const entry of payload.results) {
                    if (typeof entry.title !== "string" || typeof entry.url !== "string")
                        continue;
                    items.push({
                        title: entry.title,
                        url: entry.url,
                        snippet: typeof entry.content === "string" ? entry.content : "",
                    });
                    if (items.length >= request.count)
                        break;
                }
                finish({ ok: true, results: items });
            });
            response.on("error", () => finish({ ok: false, code: "request_failed" }));
        });
        req.on("error", (error) => {
            const code = error.code;
            if (code === "CERT_HAS_EXPIRED" ||
                code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
                code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
                code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
                finish({ ok: false, code: "tls_failed" });
                return;
            }
            finish({ ok: false, code: "request_failed" });
        });
        req.write(body);
        req.end();
    });
}
/** Convert an adapter result into the tool layer's search outcome. */
export function toWebSearchRun(result) {
    if (result.ok)
        return { kind: "completed", items: result.results };
    if (result.code === "not_configured") {
        return { kind: "unknown", safeCode: "search_backend_not_configured" };
    }
    // Every other failure may have reached the vendor: the charge stays unknown.
    return { kind: "unknown", safeCode: `search_${result.code}` };
}
