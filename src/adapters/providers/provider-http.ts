import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Bounded HTTPS POST for Provider adapters.
 *
 * This is a **trusted adapter authentication** path, not the WebFetch policy path.
 * The difference is deliberate and worth stating: a Provider endpoint is chosen by
 * the user's configuration, so address pinning and per-connection address approval
 * do not apply. WebFetch connections are chosen by model output, so they do.
 *
 * What is shared with WebFetch and still enforced here:
 * - no proxy inheritance;
 * - no automatic redirect following (a 3xx is reported, never followed);
 * - bounded connect and total time;
 * - bounded response bytes;
 * - the credential travels in a header supplied by the caller and is never logged.
 *
 * Honest limitation: this is not proof against an OS or network transparent
 * interceptor. Nothing at the application layer can be.
 */

export const PROVIDER_HTTP_LIMITS = Object.freeze({
  connectTimeoutMs: 15_000,
  totalTimeoutMs: 120_000,
  maxResponseBytes: 4 * 1024 * 1024,
  /** A Provider reply larger than this is a broken endpoint, not a long answer. */
  maxRequestBytes: 8 * 1024 * 1024,
});

export type ProviderHttpRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Extra trusted CA certificates. Used only so tests can run against a local
   * self-signed server; production relies on the system trust store.
   */
  trustedCaPem?: string;
}>;

export type ProviderHttpFailure =
  | "connect_failed"
  | "tls_failed"
  | "timeout"
  | "response_too_large"
  | "request_too_large"
  | "invalid_endpoint";

export type ProviderHttpResult =
  | Readonly<{
      ok: true;
      status: number;
      headers: Readonly<Record<string, string>>;
      bodyText: string;
      wireBytes: number;
    }>
  | Readonly<{ ok: false; code: ProviderHttpFailure }>;

export async function providerHttpsPost(input: ProviderHttpRequest): Promise<ProviderHttpResult> {
  return providerHttpsRequest("POST", input);
}

/**
 * Bounded HTTPS GET, for read-only provider endpoints such as a model list.
 *
 * Same guarantees as the POST path: HTTPS only, no proxy inheritance, no redirect
 * following, bounded connect/total time and bounded response size. A GET carries no
 * body, so `bodyText` is ignored.
 */
export async function providerHttpsGet(
  input: Omit<ProviderHttpRequest, "bodyText"> & { bodyText?: string },
): Promise<ProviderHttpResult> {
  return providerHttpsRequest("GET", { ...input, bodyText: "" });
}

async function providerHttpsRequest(
  method: "GET" | "POST",
  input: ProviderHttpRequest,
): Promise<ProviderHttpResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, code: "invalid_endpoint" };
  }
  // Provider traffic is HTTPS only. A plaintext Provider endpoint would put the
  // credential on the wire, and there is no confirmation flow here that could
  // make that acceptable the way WebFetch's explicit HTTP warning does.
  if (parsed.protocol !== "https:") return { ok: false, code: "invalid_endpoint" };
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, code: "invalid_endpoint" };
  }
  if (Buffer.byteLength(input.bodyText, "utf8") > PROVIDER_HTTP_LIMITS.maxRequestBytes) {
    return { ok: false, code: "request_too_large" };
  }

  const connectTimeoutMs = input.connectTimeoutMs ?? PROVIDER_HTTP_LIMITS.connectTimeoutMs;
  const totalTimeoutMs = input.totalTimeoutMs ?? PROVIDER_HTTP_LIMITS.totalTimeoutMs;
  const maxResponseBytes = input.maxResponseBytes ?? PROVIDER_HTTP_LIMITS.maxResponseBytes;

  return new Promise<ProviderHttpResult>((resolve) => {
    let settled = false;
    let request: ClientRequest | null = null;

    const finish = (result: ProviderHttpResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      resolve(result);
    };

    const totalTimer = setTimeout(() => {
      finish({ ok: false, code: "timeout" });
      request?.destroy();
    }, totalTimeoutMs);
    totalTimer.unref?.();

    try {
      request = httpsRequest(
        {
          method,
          host: parsed.hostname,
          port: parsed.port.length === 0 ? 443 : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          // Send SNI for a hostname. For an IP literal Node ignores `servername`
          // (RFC 6066 does not permit an IP as SNI) and the certificate must then
          // match the IP via subjectAltName, so setting it would only add a
          // deprecation warning without helping verification.
          ...(isIpLiteral(parsed.hostname) ? {} : { servername: parsed.hostname }),
          ...(input.trustedCaPem === undefined ? {} : { ca: input.trustedCaPem }),
          headers: {
            ...input.headers,
            ...(method === "POST"
              ? { "content-length": Buffer.byteLength(input.bodyText, "utf8").toString() }
              : {}),
          },
          timeout: connectTimeoutMs,
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name.toLowerCase()] = value;
          }

          if (status >= 300 && status < 400) {
            // Reported, never followed: an automatic redirect on a Provider call
            // could silently move credentials to another host.
            response.resume();
            finish({ ok: true, status, headers, bodyText: "", wireBytes: 0 });
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              finish({ ok: false, code: "response_too_large" });
              request?.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            finish({
              ok: true,
              status,
              headers,
              bodyText: Buffer.concat(chunks).toString("utf8"),
              wireBytes: received,
            });
          });
          response.on("error", () => finish({ ok: false, code: "connect_failed" }));
        },
      );
    } catch {
      finish({ ok: false, code: "connect_failed" });
      return;
    }

    request.on("timeout", () => {
      // The socket timeout covers connection establishment.
      finish({ ok: false, code: "timeout" });
      request?.destroy();
    });

    request.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (
        code === "CERT_HAS_EXPIRED" ||
        code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      ) {
        finish({ ok: false, code: "tls_failed" });
        return;
      }
      finish({ ok: false, code: code === "ETIMEDOUT" ? "timeout" : "connect_failed" });
    });

    request.end(input.bodyText);
  });
}

/**
 * True for an IPv4 or IPv6 literal. Used only to decide whether SNI applies;
 * Windows path/host validation is not this function's job.
 */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  if (hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}
