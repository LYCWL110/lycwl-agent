/**
 * Web tool validation (V1_BEHAVIOR_CONTRACTS sections 2.5/2.6 and the WebFetch
 * policy in AGENTS.md). Pure validation only: no network call is made here.
 */

export const WEB_LIMITS = Object.freeze({
  maxQueryCodePoints: 512,
  minSearchCount: 1,
  maxSearchCount: 10,
  defaultSearchCount: 10,
  fixedVendorDepth: 10,
  maxFetchRawBytes: 5 * 1024 * 1024,
  maxFetchModelUnits: 100_000,
  maxHeaderValueBytes: 512,
  /** Bounded network phases required by the baseline. */
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 20_000,
  totalTimeoutMs: 60_000,
  /** Decompressed size is bounded separately from the wire size. */
  maxDecodedBytes: 10 * 1024 * 1024,
});

export type WebFailure =
  | "invalid_arguments"
  | "invalid_query"
  | "query_too_long"
  | "control_character"
  | "invalid_count"
  | "invalid_url"
  | "unsupported_scheme"
  | "url_userinfo_forbidden"
  | "invalid_header"
  | "header_value_too_long"
  | "duplicate_header"
  | "header_not_allowed"
  | "surcharge_rejected"
  | "fee_classification_unknown";

export type WebSearchRequest = Readonly<{
  query: string;
  count: number;
  vendorDepth: number;
}>;

export type WebSearchValidation =
  | Readonly<{ ok: true; value: WebSearchRequest }>
  | Readonly<{ ok: false; code: WebFailure }>;

/**
 * Review-flagged query operators that can incur vendor surcharges. When the
 * surcharge rules are not fully classified, the request is rejected rather than
 * silently stripped or sent as a different query.
 */
const SURCHARGE_OPERATORS: readonly string[] = ["site:", "filetype:"];

export function validateWebSearch(
  args: unknown,
  options: Readonly<{ surchargeRulesReviewed: boolean }>,
): WebSearchValidation {
  if (typeof args !== "object" || args === null) {
    return { ok: false, code: "invalid_arguments" };
  }
  const record = args as Record<string, unknown>;

  const query = record["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, code: "invalid_query" };
  }
  if (hasControlCharacter(query)) return { ok: false, code: "control_character" };
  if ([...query].length > WEB_LIMITS.maxQueryCodePoints) {
    return { ok: false, code: "query_too_long" };
  }

  const rawCount = record["count"];
  const count = rawCount === undefined ? WEB_LIMITS.defaultSearchCount : rawCount;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < WEB_LIMITS.minSearchCount ||
    count > WEB_LIMITS.maxSearchCount
  ) {
    return { ok: false, code: "invalid_count" };
  }

  const lowered = query.toLowerCase();
  if (SURCHARGE_OPERATORS.some((operator) => lowered.includes(operator))) {
    // Without a reviewed fee snapshot the classification is unknown, so the
    // request must not be sent and must not be rewritten into another query.
    return {
      ok: false,
      code: options.surchargeRulesReviewed ? "surcharge_rejected" : "fee_classification_unknown",
    };
  }

  return {
    ok: true,
    value: { query, count, vendorDepth: WEB_LIMITS.fixedVendorDepth },
  };
}

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "cloud_metadata"
  | "unspecified"
  | "multicast";

export type ResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type WebFetchRequest = Readonly<{
  url: string;
  scheme: "http" | "https";
  host: string;
  port: number | null;
  headers: Readonly<Record<string, string>>;
}>;

export type WebFetchValidation =
  | Readonly<{ ok: true; value: WebFetchRequest }>
  | Readonly<{ ok: false; code: WebFailure }>;

const ALLOWED_HEADERS: ReadonlySet<string> = new Set(["accept", "accept-language"]);

export function validateWebFetch(args: unknown): WebFetchValidation {
  if (typeof args !== "object" || args === null) {
    return { ok: false, code: "invalid_arguments" };
  }
  const record = args as Record<string, unknown>;

  const rawUrl = record["url"];
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { ok: false, code: "invalid_url" };
  }
  if (hasControlCharacter(rawUrl)) return { ok: false, code: "control_character" };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, code: "unsupported_scheme" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, code: "url_userinfo_forbidden" };
  }
  if (parsed.hostname.length === 0) return { ok: false, code: "invalid_url" };

  const rawHeaders = record["headers"];
  const headers: Record<string, string> = {};
  if (rawHeaders !== undefined) {
    if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
      return { ok: false, code: "invalid_header" };
    }
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      const lowered = name.toLowerCase();
      if (!ALLOWED_HEADERS.has(lowered)) return { ok: false, code: "header_not_allowed" };
      if (seen.has(lowered)) return { ok: false, code: "duplicate_header" };
      seen.add(lowered);
      if (typeof value !== "string") return { ok: false, code: "invalid_header" };
      if (hasControlCharacter(value)) return { ok: false, code: "invalid_header" };
      if (!isAscii(value)) return { ok: false, code: "invalid_header" };
      if (Buffer.byteLength(value, "ascii") > WEB_LIMITS.maxHeaderValueBytes) {
        return { ok: false, code: "header_value_too_long" };
      }
      headers[lowered] = value;
    }
  }

  const port = parsed.port.length === 0 ? null : Number(parsed.port);
  return {
    ok: true,
    value: {
      url: parsed.toString(),
      scheme: scheme === "https:" ? "https" : "http",
      host: parsed.hostname.toLowerCase(),
      port,
      headers,
    },
  };
}

/**
 * Classify a resolved address. Localhost, private/LAN, link-local and cloud
 * metadata destinations are not blocked categorically, but the approval preview
 * must show them and require explicit confirmation.
 */
export function classifyAddress(address: string): AddressClass {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return classifyIpv4(ipv4);
  const normalized = address.toLowerCase();
  if (normalized === "::") return "unspecified";
  if (normalized === "::1") return "loopback";
  if (normalized.startsWith("fe80:")) return "link_local";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  if (normalized.startsWith("ff")) return "multicast";
  // AWS/GCP/Azure metadata service IPv6 endpoints are link-local by definition.
  return "public";
}

export function classifyAddresses(
  addresses: readonly ResolvedAddress[],
): readonly Readonly<{ address: string; family: 4 | 6; class: AddressClass }>[] {
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family,
    class: classifyAddress(entry.address),
  }));
}

export function requiresExplicitLocalApproval(
  addresses: readonly Readonly<{ class: AddressClass }>[],
): boolean {
  return addresses.some((entry) => entry.class !== "public");
}

export function formatFetchPreview(
  request: WebFetchRequest,
  addresses: readonly Readonly<{ address: string; family: 4 | 6; class: AddressClass }>[],
): string {
  const lines = [
    "web_fetch",
    `url=${request.url}`,
    `scheme=${request.scheme}`,
    ...(request.scheme === "http"
      ? ["transport=UNENCRYPTED http; request content is not protected in transit"]
      : []),
    `host=${request.host}`,
    `addresses=${addresses.map((entry) => `${entry.address}[${entry.class}]`).join(",")}`,
    `headers=${Object.keys(request.headers).sort().join(",") || "(none)"}`,
    `rawLimit=${WEB_LIMITS.maxFetchRawBytes} bytes`,
    `modelLimit=${WEB_LIMITS.maxFetchModelUnits} UTF-16 units`,
    "redirects=never followed automatically; a redirect target needs a new approved call",
    "login=no browser session, cookie replay or authentication challenge response",
  ];
  if (requiresExplicitLocalApproval(addresses)) {
    lines.push("warning=target resolves to a non-public address; explicit approval required");
  }
  return lines.join("\n");
}

function parseIpv4(address: string): readonly [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function classifyIpv4(octets: readonly [number, number, number, number]): AddressClass {
  const [a, b] = octets;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) {
    // 169.254.169.254 is the cloud metadata endpoint.
    return octets[2] === 169 && octets[3] === 254 ? "cloud_metadata" : "link_local";
  }
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "unspecified";
  return "public";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function isAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 0x7f) return false;
  }
  return true;
}
