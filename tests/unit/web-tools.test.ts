import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWebTools,
  WEB_FETCH_DEFINITION,
  WEB_SEARCH_DEFINITION,
  type WebFetchRun,
  type WebSearchRun,
  type WebToolDependencies,
} from "../../src/adapters/tools/web-tools.ts";
import { WEB_LIMITS } from "../../src/domain/web/web-policy.ts";

type Fixture = {
  tool: ReturnType<typeof createWebTools>;
  searches: unknown[];
  fetches: { addressSet: readonly string[] }[];
};

function fixture(
  options: {
    search?: WebSearchRun;
    fetch?: WebFetchRun;
    addresses?: readonly { address: string; family: 4 | 6 }[];
    surchargeRulesReviewed?: boolean;
    resolveThrows?: boolean;
    overrides?: Partial<WebToolDependencies>;
  } = {},
): Fixture {
  const searches: unknown[] = [];
  const fetches: { addressSet: readonly string[] }[] = [];
  const dependencies: WebToolDependencies = {
    surchargeRulesReviewed: options.surchargeRulesReviewed ?? true,
    resolveAddresses: async () => {
      if (options.resolveThrows === true) throw new Error("dns failure");
      return options.addresses ?? [{ address: "93.184.216.34", family: 4 }];
    },
    runSearch: async (request) => {
      searches.push(request);
      return options.search ?? { kind: "completed", items: [] };
    },
    runFetch: async (_request, approvedAddresses) => {
      fetches.push({ addressSet: approvedAddresses });
      return (
        options.fetch ?? {
          kind: "response",
          status: 200,
          location: null,
          bodyText: "body",
          rawBytes: 4,
        }
      );
    },
    ...options.overrides,
  };
  const tool = createWebTools(dependencies);
  const execute = tool.execute.bind(tool);
  tool.execute = async (request) => {
    if (request.toolName === "web_fetch") await tool.preview?.(request);
    return execute(request);
  };
  return { tool, searches, fetches };
}

describe("web tool definitions", () => {
  it("declares both tools as approval-required external requests", () => {
    const f = fixture();
    for (const definition of [WEB_SEARCH_DEFINITION, WEB_FETCH_DEFINITION]) {
      assert.equal(f.tool.getDefinition(definition.name), definition);
      assert.equal(definition.requiresApproval, true);
      assert.equal(definition.sideEffectClass, "external_request");
    }
  });
});

describe("web_search execution", () => {
  it("returns at most count results", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      title: `t${index}`,
      url: `https://e.com/${index}`,
      snippet: "s",
    }));
    const f = fixture({ search: { kind: "completed", items } });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_search",
      arguments: { query: "q", count: 2 },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /2 result\(s\) of at most 2/);
    assert.equal(f.searches.length, 1);
  });

  it("rejects a surcharge query before sending anything", async () => {
    const f = fixture({ surchargeRulesReviewed: true });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_search",
      arguments: { query: "site:example.com foo" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "surcharge_rejected", text: null });
    assert.equal(f.searches.length, 0);
  });

  it("reports an unknown search outcome without retrying", async () => {
    const f = fixture({ search: { kind: "unknown", safeCode: "vendor_timeout" } });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_search",
      arguments: { query: "q" },
    });

    assert.deepEqual(result, { status: "outcome_unknown", safeCode: "vendor_timeout" });
    assert.equal(f.searches.length, 1);
  });

  it("treats a throwing search runner as an unknown charge", async () => {
    const f = fixture({
      overrides: {
        runSearch: async () => {
          throw new Error("network reset");
        },
      },
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_search",
      arguments: { query: "q" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "search_outcome_unknown",
    });
  });
});

describe("web_fetch execution", () => {
  it("fetches only the resolved address set", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.fetches[0]?.addressSet, ["93.184.216.34"]);
    assert.match(result.text ?? "", /status 200/);
    assert.match(result.text ?? "", /body/);
  });

  it("returns a redirect target without following it", async () => {
    const f = fixture({
      fetch: {
        kind: "response",
        status: 302,
        location: "https://elsewhere.example/x",
        bodyText: "",
        rawBytes: 0,
      },
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /redirect not followed/);
    assert.match(result.text ?? "", /target=https:\/\/elsewhere\.example\/x/);
    assert.equal(f.fetches.length, 1);
  });

  it("fails explicitly when the raw response exceeds the cap", async () => {
    const f = fixture({
      fetch: {
        kind: "response",
        status: 200,
        location: null,
        bodyText: "x",
        rawBytes: WEB_LIMITS.maxFetchRawBytes + 1,
      },
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "raw_response_too_large",
      text: null,
    });
  });

  it("bounds the model-facing text", async () => {
    const f = fixture({
      fetch: {
        kind: "response",
        status: 200,
        location: null,
        bodyText: "y".repeat(WEB_LIMITS.maxFetchModelUnits + 1_000),
        rawBytes: 1_000,
      },
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /\[truncated: model budget\]/);
  });

  it("marks a near-local target in the result header", async () => {
    const f = fixture({ addresses: [{ address: "127.0.0.1", family: 4 }] });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "http://localhost:8080/" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /target=near-local/);
    assert.deepEqual(f.fetches[0]?.addressSet, ["127.0.0.1"]);
  });

  it("fails when DNS resolution fails or is empty", async () => {
    const failing = fixture({ resolveThrows: true });
    assert.deepEqual(
      await failing.tool.execute({
        toolCallId: "call-1",
        toolName: "web_fetch",
        arguments: { url: "https://example.com/" },
      }),
      { status: "failed", safeCode: "dns_resolution_failed", text: null },
    );

    const empty = fixture({ addresses: [] });
    assert.deepEqual(
      await empty.tool.execute({
        toolCallId: "call-1",
        toolName: "web_fetch",
        arguments: { url: "https://example.com/" },
      }),
      { status: "failed", safeCode: "dns_resolution_empty", text: null },
    );
  });

  it("reports an unknown fetch outcome without retrying", async () => {
    const f = fixture({ fetch: { kind: "unknown", safeCode: "connection_lost" } });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    assert.deepEqual(result, { status: "outcome_unknown", safeCode: "connection_lost" });
    assert.equal(f.fetches.length, 1);
  });
});

describe("web previews", () => {
  it("shows the query, count and paid-request effect", async () => {
    const f = fixture();
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "web_search",
      arguments: { query: "typescript", count: 3 },
    });
    assert.match(preview ?? "", /query=typescript/);
    assert.match(preview ?? "", /count=3/);
    assert.match(preview ?? "", /paid vendor request/);
    assert.equal(f.searches.length, 0);
  });

  it("shows resolved addresses and classification for fetch", async () => {
    const f = fixture({
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    });
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com/" },
    });
    assert.match(preview ?? "", /93\.184\.216\.34\[public\]/);
    assert.match(preview ?? "", /10\.0\.0\.7\[private\]/);
    assert.match(preview ?? "", /warning=target resolves to a non-public address/);
    assert.equal(f.fetches.length, 0);
  });

  it("reports a validation failure instead of a preview", async () => {
    const f = fixture();
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "web_fetch",
      arguments: { url: "ftp://example.com/" },
    });
    assert.equal(preview, "web_fetch: unsupported_scheme");
  });
});
