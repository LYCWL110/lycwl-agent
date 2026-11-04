import { lookup } from "node:dns/promises";

import {
  type AddressClass,
  classifyAddresses,
  type ResolvedAddress,
  WEB_LIMITS,
} from "../../domain/web/web-policy.ts";

/**
 * DNS resolution for WebFetch (G04).
 *
 * Every A/AAAA candidate is resolved *before* approval so the preview can show
 * the full address set and its local/private classification. The approved set is
 * then the only one the connector may use, which is what prevents a DNS
 * rebinding switch between approval and connection.
 */

export type ResolveFailure = "dns_resolution_failed" | "dns_resolution_empty";

export type ResolveResult =
  | Readonly<{
      ok: true;
      addresses: readonly ResolvedAddress[];
      classified: readonly Readonly<{ address: string; family: 4 | 6; class: AddressClass }>[];
      /** True when any candidate is not a public address. */
      requiresExplicitLocalApproval: boolean;
    }>
  | Readonly<{ ok: false; code: ResolveFailure }>;

export async function resolveWebFetchHost(host: string): Promise<ResolveResult> {
  if (host.length === 0) return { ok: false, code: "dns_resolution_failed" };

  const addresses: ResolvedAddress[] = [];
  try {
    // `all` returns every candidate; ordering is not relied on, the whole set is
    // shown and approved.
    const records = await lookup(host, { all: true, verbatim: true });
    for (const record of records) {
      const family = record.family === 6 ? 6 : 4;
      if (!addresses.some((entry) => entry.address === record.address && entry.family === family)) {
        addresses.push({ address: record.address, family });
      }
    }
  } catch {
    return { ok: false, code: "dns_resolution_failed" };
  }
  if (addresses.length === 0) return { ok: false, code: "dns_resolution_empty" };

  const classified = classifyAddresses(addresses);
  return {
    ok: true,
    addresses,
    classified,
    requiresExplicitLocalApproval: classified.some((entry) => entry.class !== "public"),
  };
}

/**
 * Build the connector's `lookup` so TLS still verifies the original hostname
 * while the socket is pinned to one approved address.
 *
 * Node calls this with `(hostname, options, callback)` for `all: false` and by
 * default may also pass `all: true`. Both shapes are handled.
 */
export function pinnedLookup(
  approvedAddresses: readonly string[],
): (
  hostname: string,
  options: unknown,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | readonly { address: string; family: number }[],
    family?: number,
  ) => void,
) => void {
  return (_hostname, options, callback) => {
    const address = approvedAddresses[0];
    if (address === undefined) {
      callback(Object.assign(new Error("no approved address"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    const family = address.includes(":") ? 6 : 4;
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      (options as { all?: unknown }).all === true;

    if (wantsAll) {
      callback(null, [{ address, family }], family);
      return;
    }
    callback(null, address, family);
  };
}

export const FETCH_TIMEOUTS = Object.freeze({
  connect: WEB_LIMITS.connectTimeoutMs,
  firstByte: WEB_LIMITS.firstByteTimeoutMs,
  total: WEB_LIMITS.totalTimeoutMs,
});
