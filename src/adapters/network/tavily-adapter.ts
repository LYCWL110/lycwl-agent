import { request as httpsRequest } from "node:https";

import type { WebSearchResultItem, WebSearchRun } from "../tools/web-tools.ts";
import { pinnedLookup, resolveWebFetchHost } from "../windows/dns-resolver.ts";

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

export type TavilySearchRequest = Readonly<{
  query: string;
  count: number;
  apiKey: string;
  /** Reviewed language/location codes from configuration, not model input. */
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
}>;

export type TavilyFailure =
  | "not_configured"
  | "authentication_failed"
  | "rate_limited"
  | "quota_exhausted"
  | "request_failed"
  | "invalid_response"
  | "tls_failed";

export type TavilyResponse = Readonly<{
  ok: true;
  results: readonly WebSearchResultItem[];
}>;

export type TavilyResult = TavilyResponse | Readonly<{ ok: false; code: TavilyFailure }>;

type TavilyPayload = {
  results?: readonly { title?: unknown; url?: unknown; content?: unknown }[];
};

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Perform one search. A failure that may have reached the vendor is returned as
 * `request_failed`; the caller records an uncertain charge and never retries.
 */
export async function tavilySearch(request: TavilySearchRequest): Promise<TavilyResult> {
  if (request.apiKey.length === 0) return { ok: false, code: "not_configured" };

  const host = new URL(TAVILY_ENDPOINT).hostname;
  const resolved = await resolveWebFetchHost(host);
  if (!resolved.ok) return { ok: false, code: "request_failed" };

  const body = JSON.stringify({
    query: request.query,
    max_results: request.count,
    search_depth: request.searchDepth ?? "basic",
    ...(request.topic === undefined ? {} : { topic: request.topic }),
  });

  return new Promise<TavilyResult>((resolve) => {
    let settled = false;
    const finish = (result: TavilyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, code: "request_failed" });
      req.destroy();
    }, 30_000);
    timer.unref?.();

    const req = httpsRequest(
      {
        method: "POST",
        host,
        path: "/search",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${request.apiKey}`,
          // Harness-managed; the model never supplies a User-Agent.
          "user-agent": "lycwl-agent/0.1",
        },
        lookup: pinnedLookup(resolved.addresses.map((entry) => entry.address)) as never,
      },
      (response) => {
        let received = 0;
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => {
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

          let payload: TavilyPayload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TavilyPayload;
          } catch {
            finish({ ok: false, code: "invalid_response" });
            return;
          }
          if (!Array.isArray(payload.results)) {
            finish({ ok: false, code: "invalid_response" });
            return;
          }

          const items: WebSearchResultItem[] = [];
          for (const entry of payload.results) {
            if (typeof entry.title !== "string" || typeof entry.url !== "string") continue;
            items.push({
              title: entry.title,
              url: entry.url,
              snippet: typeof entry.content === "string" ? entry.content : "",
            });
            if (items.length >= request.count) break;
          }
          finish({ ok: true, results: items });
        });

        response.on("error", () => finish({ ok: false, code: "request_failed" }));
      },
    );

    req.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (
        code === "CERT_HAS_EXPIRED" ||
        code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT"
      ) {
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
export function toWebSearchRun(result: TavilyResult): WebSearchRun {
  if (result.ok) return { kind: "completed", items: result.results };
  if (result.code === "not_configured") {
    return { kind: "unknown", safeCode: "search_backend_not_configured" };
  }
  // Every other failure may have reached the vendor: the charge stays unknown.
  return { kind: "unknown", safeCode: `search_${result.code}` };
}
