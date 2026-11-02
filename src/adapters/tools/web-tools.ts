import {
  classifyAddresses,
  formatFetchPreview,
  type ResolvedAddress,
  requiresExplicitLocalApproval,
  validateWebFetch,
  validateWebSearch,
  WEB_LIMITS,
  type WebFetchRequest,
  type WebSearchRequest,
} from "../../domain/web/web-policy.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

export type WebSearchResultItem = Readonly<{
  title: string;
  url: string;
  snippet: string;
}>;

export type WebSearchRun =
  | Readonly<{ kind: "completed"; items: readonly WebSearchResultItem[] }>
  | Readonly<{ kind: "unknown"; safeCode: string }>;

export type WebFetchRun =
  | Readonly<{
      kind: "response";
      status: number;
      location: string | null;
      bodyText: string;
      rawBytes: number;
    }>
  | Readonly<{ kind: "unknown"; safeCode: string }>;

export type WebToolDependencies = Readonly<{
  /** True only after the fee/surcharge snapshot has been reviewed (G10). */
  surchargeRulesReviewed: boolean;
  /** Resolve every A/AAAA candidate before approval is shown. */
  resolveAddresses: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** Injected search runner; the paid vendor call is not implemented here. */
  runSearch: (request: WebSearchRequest) => Promise<WebSearchRun>;
  /** Injected fetch runner; must not follow redirects automatically. */
  runFetch: (
    request: WebFetchRequest,
    approvedAddresses: readonly string[],
  ) => Promise<WebFetchRun>;
}>;

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: "web_search",
  version: "1",
  sideEffectClass: "external_request",
  requiresApproval: true,
  concurrencySafe: false,
};

export const WEB_FETCH_DEFINITION: ToolDefinition = {
  name: "web_fetch",
  version: "1",
  sideEffectClass: "external_request",
  requiresApproval: true,
  concurrencySafe: false,
};

const DEFINITIONS: readonly ToolDefinition[] = [WEB_SEARCH_DEFINITION, WEB_FETCH_DEFINITION];

export function createWebTools(dependencies: WebToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      if (request.toolName === WEB_SEARCH_DEFINITION.name) {
        const validated = validateWebSearch(request.arguments, {
          surchargeRulesReviewed: dependencies.surchargeRulesReviewed,
        });
        if (!validated.ok) return `web_search: ${validated.code}`;
        return [
          "web_search",
          `query=${validated.value.query}`,
          `count=${validated.value.count}`,
          `vendorDepth=${validated.value.vendorDepth}`,
          "effect=paid vendor request; results are untrusted input",
        ].join("\n");
      }
      if (request.toolName !== WEB_FETCH_DEFINITION.name) return null;

      const validated = validateWebFetch(request.arguments);
      if (!validated.ok) return `web_fetch: ${validated.code}`;
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await dependencies.resolveAddresses(validated.value.host);
      } catch {
        return "web_fetch: dns_resolution_failed";
      }
      if (addresses.length === 0) return "web_fetch: dns_resolution_empty";
      return formatFetchPreview(validated.value, classifyAddresses(addresses));
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      if (request.toolName === WEB_SEARCH_DEFINITION.name) {
        return executeSearch(dependencies, request.arguments);
      }
      if (request.toolName === WEB_FETCH_DEFINITION.name) {
        return executeFetch(dependencies, request.arguments);
      }
      return { status: "failed", safeCode: "unknown_tool", text: null };
    },
  };
}

async function executeSearch(
  dependencies: WebToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  const validated = validateWebSearch(args, {
    surchargeRulesReviewed: dependencies.surchargeRulesReviewed,
  });
  if (!validated.ok) return { status: "failed", safeCode: validated.code, text: null };

  let run: WebSearchRun;
  try {
    run = await dependencies.runSearch(validated.value);
  } catch {
    // A paid request may already have been sent; keep the charge unknown.
    return { status: "outcome_unknown", safeCode: "search_outcome_unknown" };
  }
  if (run.kind === "unknown") {
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

async function executeFetch(
  dependencies: WebToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  const validated = validateWebFetch(args);
  if (!validated.ok) return { status: "failed", safeCode: validated.code, text: null };

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await dependencies.resolveAddresses(validated.value.host);
  } catch {
    return { status: "failed", safeCode: "dns_resolution_failed", text: null };
  }
  if (addresses.length === 0) {
    return { status: "failed", safeCode: "dns_resolution_empty", text: null };
  }

  const classified = classifyAddresses(addresses);
  const approvedSet = classified.map((entry) => entry.address);
  // The approval is bound to this address set; a change needs a new call.
  let run: WebFetchRun;
  try {
    run = await dependencies.runFetch(validated.value, approvedSet);
  } catch {
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

function boundFetchText(body: string): Readonly<{ text: string }> {
  if (body.length <= WEB_LIMITS.maxFetchModelUnits) return { text: body };
  return {
    text: `${body.slice(0, WEB_LIMITS.maxFetchModelUnits)}\n[truncated: model budget]`,
  };
}
