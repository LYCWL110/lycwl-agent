import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { WEB_LIMITS } from "../../domain/web/web-policy.ts";
import { pinnedLookup } from "./dns-resolver.ts";

/**
 * Pinned-address HTTP/TLS connector (G04).
 *
 * The socket is pinned to an approved address through a custom `lookup`, while
 * TLS still verifies the certificate against the *original hostname* and sends
 * that hostname as SNI. There is no proxy inheritance, no redirect following and
 * no cookie or login handling. All four network phases are bounded.
 *
 * Honest limitation: this is not proof against an OS or network transparent
 * interceptor, as the baseline itself states.
 */

export type FetchFailure =
  | "connect_failed"
  | "tls_failed"
  | "too_many_redirects"
  | "response_too_large"
  | "timeout"
  | "invalid_response";

export type FetchResponse = Readonly<{
  ok: true;
  status: number;
  /** Present only for a redirect status; never followed automatically. */
  location: string | null;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
  wireBytes: number;
}>;

export type FetchResult = FetchResponse | Readonly<{ ok: false; code: FetchFailure }>;

export type FetchRequest = Readonly<{
  url: string;
  host: string;
  scheme: "http" | "https";
  headers: Readonly<Record<string, string>>;
  /** The exact approved address set; the socket uses one of these only. */
  approvedAddresses: readonly string[];
  /** Harness-managed User-Agent; the model cannot supply it. */
  userAgent: string;
  /**
   * Extra trusted CA certificates. Used only so tests can run against a local
   * self-signed server; production callers leave this undefined and rely on the
   * system trust store.
   */
  trustedCaPem?: string;
}>;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([300, 301, 302, 303, 307, 308]);

export async function pinnedFetch(fetchRequest: FetchRequest): Promise<FetchResult> {
  if (fetchRequest.approvedAddresses.length === 0) {
    return { ok: false, code: "connect_failed" };
  }

  const parsed = new URL(fetchRequest.url);
  const isHttps = fetchRequest.scheme === "https";
  const requester = isHttps ? httpsRequest : httpRequest;

  return new Promise<FetchResult>((resolve) => {
    let settled = false;
    const finish = (result: FetchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      resolve(result);
    };

    const totalTimer = setTimeout(() => {
      finish({ ok: false, code: "timeout" });
      request.destroy();
    }, WEB_LIMITS.totalTimeoutMs);
    totalTimer.unref?.();

    let request: ClientRequest;
    try {
      request = requester(
        {
          method: "GET",
          host: fetchRequest.host,
          port: parsed.port.length === 0 ? undefined : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          // Original-hostname verification and SNI stay bound to the host, not
          // the IP, because `host` is unchanged and only `lookup` is pinned.
          servername: isHttps ? fetchRequest.host : undefined,
          ...(fetchRequest.trustedCaPem === undefined ? {} : { ca: fetchRequest.trustedCaPem }),
          headers: {
            ...fetchRequest.headers,
            "user-agent": fetchRequest.userAgent,
          },
          // No proxy: an explicit agent with proxy disabled by omission.
          lookup: pinnedLookup(fetchRequest.approvedAddresses) as never,
          // Bounded connection establishment.
          timeout: WEB_LIMITS.connectTimeoutMs,
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name.toLowerCase()] = value;
          }

          if (REDIRECT_STATUSES.has(status)) {
            // Never followed: the target is returned for a new approved call.
            response.resume();
            finish({
              ok: true,
              status,
              location: headers["location"] ?? null,
              headers,
              bodyText: "",
              wireBytes: 0,
            });
            return;
          }

          let received = 0;
          let decoded = 0;
          const chunks: Buffer[] = [];

          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            decoded += chunk.length;
            if (received > WEB_LIMITS.maxFetchRawBytes) {
              finish({ ok: false, code: "response_too_large" });
              request.destroy();
              return;
            }
            if (decoded > WEB_LIMITS.maxDecodedBytes) {
              finish({ ok: false, code: "response_too_large" });
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });

          response.on("end", () => {
            finish({
              ok: true,
              status,
              location: null,
              headers,
              bodyText: Buffer.concat(chunks).toString("utf8"),
              wireBytes: received,
            });
          });

          response.on("error", () => {
            finish({ ok: false, code: "invalid_response" });
          });
        },
      );
    } catch {
      finish({ ok: false, code: "connect_failed" });
      return;
    }

    request.on("timeout", () => {
      // The socket-level timeout covers connection establishment.
      finish({ ok: false, code: "timeout" });
      request.destroy();
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
      if (code === "ETIMEDOUT") {
        finish({ ok: false, code: "timeout" });
        return;
      }
      finish({ ok: false, code: "connect_failed" });
    });

    request.end();
  });
}
