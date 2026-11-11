import { classifyAddresses, formatFetchPreview, requiresExplicitLocalApproval, validateWebFetch, validateWebSearch, WEB_LIMITS, } from "../../domain/web/web-policy.js";
export const WEB_SEARCH_DEFINITION = {
    name: "web_search",
    version: "1",
    sideEffectClass: "external_request",
    requiresApproval: true,
    concurrencySafe: false,
};
export const WEB_FETCH_DEFINITION = {
    name: "web_fetch",
    version: "1",
    sideEffectClass: "external_request",
    requiresApproval: true,
    concurrencySafe: false,
};
const DEFINITIONS = [WEB_SEARCH_DEFINITION, WEB_FETCH_DEFINITION];
/**
 * Search failure codes that prove the request was never sent, so they are
 * definite failures rather than uncertain charges.
 */
const NEVER_SENT_SEARCH_CODES = new Set([
    "search_backend_not_configured",
    "search_run_limit",
    "search_monthly_limit",
    "search_ledger_corrupt",
    "search_ledger_unreadable",
    "search_duplicate_reservation",
    "search_ledger_write_failed",
]);
export function createWebTools(dependencies) {
    const snapshots = new Map();
    async function fetchSnapshot(request) {
        const validated = validateWebFetch(request.arguments);
        if (!validated.ok)
            return null;
        const addresses = await dependencies.resolveAddresses(validated.value.host);
        if (addresses.length === 0)
            return null;
        return JSON.stringify({
            request: validated.value,
            addresses: [
                ...new Set(addresses.map((address) => `${address.family}:${address.address.toLowerCase()}`)),
            ].sort(),
        });
    }
    return {
        getDefinition(toolName) {
            return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
        },
        async preview(request) {
            if (request.toolName === WEB_SEARCH_DEFINITION.name) {
                const validated = validateWebSearch(request.arguments, {
                    surchargeRulesReviewed: dependencies.surchargeRulesReviewed,
                });
                if (!validated.ok)
                    return `web_search: ${validated.code}`;
                return [
                    "web_search",
                    `query=${validated.value.query}`,
                    `count=${validated.value.count}`,
                    `vendorDepth=${validated.value.vendorDepth}`,
                    "effect=paid vendor request; results are untrusted input",
                ].join("\n");
            }
            if (request.toolName !== WEB_FETCH_DEFINITION.name)
                return null;
            snapshots.delete(request.toolCallId);
            const validated = validateWebFetch(request.arguments);
            if (!validated.ok)
                return `web_fetch: ${validated.code}`;
            let addresses;
            try {
                addresses = await dependencies.resolveAddresses(validated.value.host);
            }
            catch {
                return "web_fetch: dns_resolution_failed";
            }
            if (addresses.length === 0)
                return "web_fetch: dns_resolution_empty";
            snapshots.set(request.toolCallId, JSON.stringify({
                request: validated.value,
                addresses: [
                    ...new Set(addresses.map((address) => `${address.family}:${address.address.toLowerCase()}`)),
                ].sort(),
            }));
            return formatFetchPreview(validated.value, classifyAddresses(addresses));
        },
        async revalidateApproval(request) {
            if (request.toolName !== WEB_FETCH_DEFINITION.name)
                return true;
            try {
                const current = await fetchSnapshot(request);
                return current !== null && current === snapshots.get(request.toolCallId);
            }
            catch {
                return false;
            }
        },
        discardApproval(toolCallId) {
            snapshots.delete(toolCallId);
        },
        async execute(request) {
            if (request.toolName === WEB_SEARCH_DEFINITION.name) {
                return executeSearch(dependencies, request.arguments, request.toolCallId);
            }
            if (request.toolName === WEB_FETCH_DEFINITION.name) {
                const snapshot = snapshots.get(request.toolCallId);
                snapshots.delete(request.toolCallId);
                return executeFetch(dependencies, request.arguments, snapshot);
            }
            return { status: "failed", safeCode: "unknown_tool", text: null };
        },
    };
}
async function executeSearch(dependencies, args, toolCallId) {
    const validated = validateWebSearch(args, {
        surchargeRulesReviewed: dependencies.surchargeRulesReviewed,
    });
    if (!validated.ok)
        return { status: "failed", safeCode: validated.code, text: null };
    let run;
    try {
        run = await dependencies.runSearch(validated.value, toolCallId);
    }
    catch {
        // A paid request may already have been sent; keep the charge unknown.
        return { status: "outcome_unknown", safeCode: "search_outcome_unknown" };
    }
    if (run.kind === "unknown") {
        // Codes that prove nothing was sent are definite failures, not uncertain
        // charges: a missing backend, an exhausted quota or an unusable ledger all
        // stopped the request before any network send.
        if (NEVER_SENT_SEARCH_CODES.has(run.safeCode)) {
            return { status: "failed", safeCode: run.safeCode, text: null };
        }
        return { status: "outcome_unknown", safeCode: run.safeCode };
    }
    const items = run.items.slice(0, validated.value.count);
    return {
        status: "succeeded",
        text: [
            `web_search: ${items.length} result(s) of at most ${validated.value.count}`,
            ...items.map((item) => `${item.title} | ${item.url}\n${item.snippet}`),
        ].join("\n"),
    };
}
async function executeFetch(dependencies, args, approvedSnapshot) {
    const validated = validateWebFetch(args);
    if (!validated.ok)
        return { status: "failed", safeCode: validated.code, text: null };
    let addresses;
    try {
        addresses = await dependencies.resolveAddresses(validated.value.host);
    }
    catch {
        return { status: "failed", safeCode: "dns_resolution_failed", text: null };
    }
    if (addresses.length === 0) {
        return { status: "failed", safeCode: "dns_resolution_empty", text: null };
    }
    const classified = classifyAddresses(addresses);
    const currentSnapshot = JSON.stringify({
        request: validated.value,
        addresses: [
            ...new Set(addresses.map((address) => `${address.family}:${address.address.toLowerCase()}`)),
        ].sort(),
    });
    if (approvedSnapshot === undefined || approvedSnapshot !== currentSnapshot) {
        return { status: "failed", safeCode: "fetch_approval_changed", text: null };
    }
    const approvedSet = classified.map((entry) => entry.address);
    // The approval is bound to this address set; a change needs a new call.
    let run;
    try {
        run = await dependencies.runFetch(validated.value, approvedSet);
    }
    catch {
        return { status: "outcome_unknown", safeCode: "fetch_outcome_unknown" };
    }
    if (run.kind === "unknown") {
        return { status: "outcome_unknown", safeCode: run.safeCode };
    }
    if (run.rawBytes > WEB_LIMITS.maxFetchRawBytes) {
        // Fail explicitly rather than presenting partial content as complete.
        return { status: "failed", safeCode: "raw_response_too_large", text: null };
    }
    if (run.location !== null) {
        // Never follow automatically; the target requires a new approved call.
        return {
            status: "succeeded",
            text: [
                `web_fetch: redirect not followed (status ${run.status})`,
                `target=${run.location}`,
                "effect=request this target with a new web_fetch call and its own approval",
            ].join("\n"),
        };
    }
    const bounded = boundFetchText(run.bodyText);
    const header = [
        `web_fetch: status ${run.status}`,
        `bytes=${run.rawBytes}`,
        `addresses=${approvedSet.join(",")}`,
        ...(requiresExplicitLocalApproval(classified) ? ["target=near-local"] : []),
    ].join("\n");
    return { status: "succeeded", text: `${header}\n${bounded.text}` };
}
function boundFetchText(body) {
    if (body.length <= WEB_LIMITS.maxFetchModelUnits)
        return { text: body };
    return {
        text: `${body.slice(0, WEB_LIMITS.maxFetchModelUnits)}\n[partial: cut to fit the token budget]`,
    };
}
