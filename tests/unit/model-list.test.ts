import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchModelList,
  modelListPath,
  parseModelList,
} from "../../src/adapters/providers/model-list.ts";
import type { ProviderHttpResult } from "../../src/adapters/providers/provider-http.ts";

/**
 * Model-list fetching is a configuration convenience: it tells the user what they can
 * type. A failure must leave the browser usable rather than unreachable.
 */

function get(result: ProviderHttpResult) {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  return {
    calls,
    get: async (input: { url: string; headers: Readonly<Record<string, string>> }) => {
      calls.push(input);
      return result;
    },
  };
}

function ok(body: unknown): ProviderHttpResult {
  return {
    ok: true,
    status: 200,
    headers: {},
    bodyText: JSON.stringify(body),
    wireBytes: 0,
  };
}

describe("model list parsing", () => {
  it("reads declared effort values, retaining metadata for an existing model ID", () => {
    assert.deepEqual(
      parseModelList(
        JSON.stringify({
          data: [
            {
              id: "custom",
              supported_reasoning_efforts: ["high", "low", "high", "future", "\u001b[31m"],
            },
            { id: "plain" },
          ],
        }),
      ),
      {
        ok: true,
        models: ["custom", "plain"],
        catalog: [{ id: "custom", reasoning: { efforts: ["low", "high"] } }, { id: "plain" }],
      },
    );
  });

  it("reads the OpenRouter reasoning declaration, including unrestricted and empty lists", () => {
    const result = parseModelList(
      JSON.stringify({
        data: [
          { id: "a", reasoning: { supported_efforts: ["none", "low", "high"] } },
          { id: "b", reasoning: { supported_efforts: null } },
          { id: "c", supported_reasoning_efforts: [] },
        ],
      }),
    );
    assert.deepEqual(result, {
      ok: true,
      models: ["a", "b", "c"],
      catalog: [
        { id: "a", reasoning: { efforts: ["none", "low", "high"] } },
        {
          id: "b",
          reasoning: { efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
        },
        { id: "c", reasoning: { efforts: [] } },
      ],
    });
  });

  it("does not infer levels from a model name, parameters, or an invalid declaration", () => {
    for (const entry of [
      { id: "gpt-5", supported_reasoning_efforts: "low,high" },
      { id: "gpt-5", supported_reasoning_efforts: [null, "high"] },
      { id: "gpt-5", supported_reasoning_efforts: null },
      { id: "gpt-5", reasoning: { supported_efforts: true } },
      {
        id: "gpt-5",
        supported_reasoning_efforts: ["low"],
        reasoning: { supported_efforts: ["high"] },
      },
    ])
      assert.deepEqual(parseModelList(JSON.stringify({ data: [entry] })), {
        ok: true,
        models: ["gpt-5"],
        catalog: [{ id: "gpt-5", reasoningInvalid: true }],
      });
    assert.deepEqual(
      parseModelList(
        JSON.stringify({
          data: [{ id: "gpt-5", supported_parameters: ["reasoning", "reasoning_effort"] }],
        }),
      ),
      { ok: true, models: ["gpt-5"] },
    );
  });

  it("discards conflicting duplicate declarations rather than combining them", () => {
    assert.deepEqual(
      parseModelList(
        JSON.stringify({
          data: [
            { id: "a", supported_reasoning_efforts: ["low"] },
            { id: "a", supported_reasoning_efforts: ["high"] },
            { id: "a", supported_reasoning_efforts: ["low"] },
          ],
        }),
      ),
      { ok: true, models: ["a"], catalog: [{ id: "a", reasoningInvalid: true }] },
    );
  });

  it("reads the data array shape", () => {
    const result = parseModelList(
      JSON.stringify({ data: [{ id: "claude-a" }, { id: "claude-b" }] }),
    );
    assert.deepEqual(result, { ok: true, models: ["claude-a", "claude-b"] });
  });

  it("reads a plain array of objects", () => {
    assert.deepEqual(parseModelList(JSON.stringify([{ id: "m1" }])), {
      ok: true,
      models: ["m1"],
    });
  });

  it("reads a plain array of strings", () => {
    assert.deepEqual(parseModelList(JSON.stringify(["a", "b"])), {
      ok: true,
      models: ["a", "b"],
    });
  });

  it("reads a models array", () => {
    assert.deepEqual(parseModelList(JSON.stringify({ models: [{ id: "x" }] })), {
      ok: true,
      models: ["x"],
    });
  });

  it("sorts and deduplicates", () => {
    const result = parseModelList(
      JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }),
    );
    assert.deepEqual(result, { ok: true, models: ["a", "b"] });
  });

  it("skips entries without an id or name", () => {
    assert.deepEqual(
      parseModelList(JSON.stringify({ data: [{ id: "a" }, { nope: 1 }, { id: "" }] })),
      { ok: true, models: ["a"] },
    );
  });

  it("accepts a name field when there is no id", () => {
    assert.deepEqual(parseModelList(JSON.stringify({ data: [{ name: "named" }] })), {
      ok: true,
      models: ["named"],
    });
  });

  it("rejects a non-JSON body", () => {
    assert.deepEqual(parseModelList("<html>"), { ok: false, code: "body_not_json" });
  });

  it("rejects an unexpected shape rather than reporting an empty catalogue", () => {
    assert.deepEqual(parseModelList(JSON.stringify({ nope: true })), {
      ok: false,
      code: "unexpected_shape",
    });
  });
});

describe("model list fetching", () => {
  it("preserves effort metadata using only the existing model-list GET", async () => {
    const captured = get(
      ok({ data: [{ id: "model", reasoning: { supported_efforts: ["low", "high"] } }] }),
    );
    const result = await fetchModelList({
      protocol: "openai_responses",
      baseUrl: "https://gateway.example",
      apiKey: "fixture",
      get: captured.get,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.catalog, [{ id: "model", reasoning: { efforts: ["low", "high"] } }]);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0]?.url, "https://gateway.example/v1/models");
  });
  it("uses one version segment for pasted version roots and keeps a gateway prefix", async () => {
    for (const baseUrl of [
      "https://gateway.example/v1",
      "https://gateway.example/v1/",
      "https://gateway.example/openai/v1",
    ]) {
      const captured = get(ok({ data: [] }));
      await fetchModelList({
        protocol: "openai_chat",
        baseUrl,
        apiKey: "fixture",
        get: captured.get,
      });
      assert.equal(
        captured.calls[0]?.url,
        `${baseUrl.includes("/openai/") ? "https://gateway.example/openai" : "https://gateway.example"}/v1/models`,
      );
    }
  });
  it("uses the anthropic header shape", async () => {
    const captured = get(ok({ data: [{ id: "claude-a" }] }));
    const result = await fetchModelList({
      protocol: "anthropic_messages",
      baseUrl: "https://api.example.com",
      apiKey: "k",
      get: captured.get,
    });
    assert.deepEqual(result, { ok: true, models: ["claude-a"] });
    const call = captured.calls[0];
    assert.ok(call);
    assert.equal(call.url, "https://api.example.com/v1/models");
    assert.equal(call.headers["x-api-key"], "k");
    assert.equal(call.headers["authorization"], undefined);
  });

  it("uses a bearer header for the OpenAI protocols", async () => {
    const captured = get(ok({ data: [{ id: "gpt-a" }] }));
    await fetchModelList({
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/",
      apiKey: "k",
      get: captured.get,
    });
    const call = captured.calls[0];
    assert.ok(call);
    assert.equal(call.url, "https://api.example.com/v1/models");
    assert.equal(call.headers["authorization"], "Bearer k");
  });

  it("reports a 404 as not_supported rather than an error", async () => {
    const captured = get({
      ok: true,
      status: 404,
      headers: {},
      bodyText: "",
      wireBytes: 0,
    });
    assert.deepEqual(
      await fetchModelList({
        protocol: "openai_responses",
        baseUrl: "https://x",
        apiKey: "k",
        get: captured.get,
      }),
      { ok: false, code: "not_supported" },
    );
  });

  it("maps 401 to an authentication code", async () => {
    const captured = get({
      ok: true,
      status: 401,
      headers: {},
      bodyText: "",
      wireBytes: 0,
    });
    const result = await fetchModelList({
      protocol: "anthropic_messages",
      baseUrl: "https://x",
      apiKey: "k",
      get: captured.get,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.code, /unauthorized/);
  });

  it("does not call the network without a key", async () => {
    const captured = get(ok({ data: [] }));
    const result = await fetchModelList({
      protocol: "anthropic_messages",
      baseUrl: "https://x",
      apiKey: "",
      get: captured.get,
    });
    assert.deepEqual(result, { ok: false, code: "key_not_configured" });
    assert.equal(captured.calls.length, 0);
  });

  it("reports a transport failure without throwing", async () => {
    const captured = get({ ok: false, code: "timeout" });
    const result = await fetchModelList({
      protocol: "anthropic_messages",
      baseUrl: "https://x",
      apiKey: "k",
      get: captured.get,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.code, /timeout/);
  });

  it("has a list path for every supported protocol", () => {
    for (const protocol of ["anthropic_messages", "openai_chat", "openai_responses"] as const) {
      assert.equal(typeof modelListPath(protocol), "string");
    }
  });
});
