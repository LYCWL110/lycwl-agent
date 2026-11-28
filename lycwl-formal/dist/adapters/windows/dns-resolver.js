import { lookup } from "node:dns/promises";
import { classifyAddresses, WEB_LIMITS, } from "../../domain/web/web-policy.js";
export async function resolveWebFetchHost(host) {
    if (host.length === 0)
        return { ok: false, code: "dns_resolution_failed" };
    const addresses = [];
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
    }
    catch {
        return { ok: false, code: "dns_resolution_failed" };
    }
    if (addresses.length === 0)
        return { ok: false, code: "dns_resolution_empty" };
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
export function pinnedLookup(approvedAddresses) {
    return (_hostname, options, callback) => {
        const address = approvedAddresses[0];
        if (address === undefined) {
            callback(Object.assign(new Error("no approved address"), { code: "ENOTFOUND" }), "", 0);
            return;
        }
        const family = address.includes(":") ? 6 : 4;
        const wantsAll = typeof options === "object" &&
            options !== null &&
            "all" in options &&
            options.all === true;
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
