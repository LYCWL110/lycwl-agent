import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchModelDetails,
  parseModelDetails,
  parseModelList,
} from "../../src/adapters/providers/model-list.ts";
import {
  SUPPORTED_PROTOCOLS,
  validateProviderConfig,
} from "../../src/domain/config/provider-config.ts";

const metadata = {
  id: "model",
  effort: {
    supported_levels: ["low", "medium", "high", "xhigh", "max"],
    default_level: "medium",
  },
};

describe("reasoning metadata across protocols", () => {
  for (const protocol of SUPPORTED_PROTOCOLS) {
    it(`reads supported_levels and default_level for ${protocol}`, () => {
      const expected = {
        id: "model",
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "medium",
        },
      };
      assert.deepEqual(parseModelDetails(JSON.stringify(metadata), protocol), {
        ok: true,
        model: expected,
      });
      const list = parseModelList(JSON.stringify({ data: [metadata] }), protocol);
      assert.ok(list.ok);
      assert.deepEqual(list.catalog, [expected]);
      assert.deepEqual(parseModelDetails(JSON.stringify({ data: metadata }), protocol), {
        ok: true,
        model: expected,
      });
    });

    it(`looks up only the selected model with ${protocol} authentication`, async () => {
      const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
      const result = await fetchModelDetails({
        protocol,
        baseUrl: "https://gateway.example/prefix/v1",
        apiKey: "fixture",
        model: "vendor/model?x=1",
        get: async (request) => {
          calls.push(request);
          return {
            ok: true,
            status: 200,
            headers: {},
            wireBytes: 0,
            bodyText: JSON.stringify({ ...metadata, id: "vendor/model?x=1" }),
          };
        },
      });
      assert.ok(result.ok);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0]?.url,
        "https://gateway.example/prefix/v1/models/vendor%2Fmodel%3Fx%3D1",
      );
      assert.equal(
        calls[0]?.headers[protocol === "anthropic_messages" ? "x-api-key" : "authorization"],
        protocol === "anthropic_messages" ? "fixture" : "Bearer fixture",
      );
    });

    it(`accepts configured max for ${protocol}`, () => {
      assert.ok(
        validateProviderConfig({
          protocol,
          model: "model",
          baseUrl: "https://gateway.example",
          credentialRef: "fixture",
          reasoningEffort: "max",
        }).ok,
      );
    });
  }

  it("reads Anthropic capability flags and keeps partial/unsupported states distinct", () => {
    const model = (effort: unknown) =>
      parseModelDetails(
        JSON.stringify({
          id: "model",
          capabilities: { effort },
        }),
        "anthropic_messages",
      );
    assert.deepEqual(
      model({
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: false },
      }),
      { ok: true, model: { id: "model", reasoning: { efforts: ["low", "medium", "high"] } } },
    );
    assert.deepEqual(model({ supported: false }), {
      ok: true,
      model: { id: "model", reasoning: { efforts: [] } },
    });
    assert.deepEqual(model({ supported: true }), { ok: true, model: { id: "model" } });
    for (const value of [{ supported: "true" }, { supported: true, low: { supported: "true" } }])
      assert.deepEqual(model(value), { ok: true, model: { id: "model", reasoningInvalid: true } });
  });

  it("ignores defaults outside the declared levels and rejects conflicting declarations", () => {
    const result = parseModelDetails(
      JSON.stringify({
        id: "model",
        effort: { supported_levels: ["low", "high"], default_level: "\u001b[31m" },
      }),
      "openai_responses",
    );
    assert.deepEqual(result, {
      ok: true,
      model: { id: "model", reasoning: { efforts: ["low", "high"] } },
    });
    for (const effort of [{ supported_levels: "low,high" }, { supported_levels: [true] }])
      assert.deepEqual(parseModelDetails(JSON.stringify({ id: "model", effort }), "openai_chat"), {
        ok: true,
        model: { id: "model", reasoningInvalid: true },
      });
    assert.deepEqual(
      parseModelDetails(
        JSON.stringify({ ...metadata, supported_reasoning_efforts: ["low"] }),
        "openai_chat",
      ),
      { ok: true, model: { id: "model", reasoningInvalid: true } },
    );
    assert.deepEqual(
      parseModelDetails(
        JSON.stringify({ id: "model", reasoning: { effort: "high" } }),
        "openai_responses",
      ),
      { ok: true, model: { id: "model" } },
    );
  });

  it("refuses a detail response for another model and handles missing endpoints", async () => {
    for (const status of [200, 404, 401]) {
      const result = await fetchModelDetails({
        protocol: "openai_chat",
        baseUrl: "https://gateway.example",
        apiKey: "fixture",
        model: "requested",
        get: async () => ({
          ok: true,
          status,
          headers: {},
          wireBytes: 0,
          bodyText: JSON.stringify(metadata),
        }),
      });
      assert.equal(result.ok, false);
      if (result.ok) continue;
      if (status === 200) assert.equal(result.code, "model_mismatch");
      if (status === 404) assert.equal(result.code, "not_supported");
    }
  });

  it("does not send a key for invalid or dot-segment model identifiers", async () => {
    for (const model of ["", ".", "..", "\ud800"]) {
      let called = false;
      const result = await fetchModelDetails({
        protocol: "openai_chat",
        baseUrl: "https://gateway.example",
        apiKey: "fixture",
        model,
        get: async () => {
          called = true;
          throw new Error("unexpected");
        },
      });
      assert.equal(result.ok, false);
      assert.equal(called, false);
    }
  });
});
