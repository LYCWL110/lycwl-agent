import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModelDetails, parseModelList } from "../../src/adapters/providers/model-list.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveModelContext,
} from "../../src/domain/config/model-context.ts";

describe("model context metadata", () => {
  it("retains context metadata without requiring reasoning metadata", () => {
    assert.deepEqual(
      parseModelList(JSON.stringify({ data: [{ id: "model", context_length: 131072 }] })),
      {
        ok: true,
        models: ["model"],
        catalog: [{ id: "model", contextWindow: 131072 }],
      },
    );
  });

  it("reads model details independently of supported efforts", () => {
    assert.deepEqual(
      parseModelDetails(
        JSON.stringify({
          id: "model",
          max_input_tokens: 200000,
          effort: { supported_levels: ["low", "high"] },
        }),
        "anthropic_messages",
      ),
      {
        ok: true,
        model: { id: "model", contextWindow: 200000, reasoning: { efforts: ["low", "high"] } },
      },
    );
  });

  it("supports declared context and input limits but never output limits", () => {
    for (const fields of [
      { context_length: 65536 },
      { context_window: 65536 },
      { contextWindow: 65536 },
      { max_context_length: 65536 },
      { max_input_tokens: 65536 },
      { input_token_limit: 65536 },
      { limits: { context: 65536 } },
    ]) {
      const result = parseModelDetails(JSON.stringify({ id: "model", ...fields }), "openai_chat");
      assert.ok(result.ok);
      assert.equal(result.model.contextWindow, 65536);
    }
    const outputOnly = parseModelDetails(
      JSON.stringify({ id: "model", max_output_tokens: 65536 }),
      "openai_chat",
    );
    assert.ok(outputOnly.ok);
    assert.equal(outputOnly.model.contextWindow, undefined);
    const totalAndInput = parseModelDetails(
      JSON.stringify({ id: "model", context_length: 131072, max_input_tokens: 126976 }),
      "openai_chat",
    );
    assert.ok(totalAndInput.ok);
    assert.equal(totalAndInput.model.contextWindow, 131072);
  });

  it("rejects malformed or conflicting declarations independently of reasoning", () => {
    for (const value of [null, "131072", 0, -1, 8191, 4000001, 65536.5]) {
      const result = parseModelDetails(
        JSON.stringify({
          id: "model",
          context_length: value,
          supported_reasoning_efforts: ["high"],
        }),
        "openai_chat",
      );
      assert.ok(result.ok);
      assert.equal(result.model.contextWindowInvalid, true);
      assert.deepEqual(result.model.reasoning?.efforts, ["high"]);
      assert.equal(resolveModelContext(result.model).contextWindow, DEFAULT_CONTEXT_WINDOW);
    }
    const conflict = parseModelDetails(
      JSON.stringify({ id: "model", context_length: 65536, context_window: 131072 }),
      "openai_chat",
    );
    assert.ok(conflict.ok);
    assert.equal(conflict.model.contextWindowInvalid, true);
  });

  it("does not merge conflicting duplicate context or reasoning declarations", () => {
    const duplicate = parseModelList(
      JSON.stringify({
        data: [
          { id: "model", context_length: 65536, supported_reasoning_efforts: ["high"] },
          { id: "model", context_length: 131072, supported_reasoning_efforts: ["high"] },
        ],
      }),
    );
    assert.ok(duplicate.ok);
    assert.deepEqual(duplicate.catalog, [
      { id: "model", contextWindowInvalid: true, reasoning: { efforts: ["high"] } },
    ]);
    const reverse = parseModelList(
      JSON.stringify({
        data: [
          { id: "model", context_length: 65536, supported_reasoning_efforts: ["high"] },
          { id: "model", context_length: 65536, supported_reasoning_efforts: ["low"] },
        ],
      }),
    );
    assert.ok(reverse.ok);
    assert.deepEqual(reverse.catalog, [
      { id: "model", contextWindow: 65536, reasoningInvalid: true },
    ]);
  });

  it("uses valid manual limits, otherwise upstream lengths, otherwise exactly 272k", () => {
    assert.deepEqual(resolveModelContext({ contextWindow: 131072 }), {
      contextWindow: 131072,
      contextWindowSource: "upstream",
    });
    assert.deepEqual(resolveModelContext({ contextWindow: 131072 }, 32768), {
      contextWindow: 32768,
      contextWindowSource: "manual",
    });
    assert.deepEqual(resolveModelContext(undefined), {
      contextWindow: 272000,
      contextWindowSource: "default",
    });
    assert.deepEqual(resolveModelContext({ contextWindow: 65536, contextWindowInvalid: true }), {
      contextWindow: 272000,
      contextWindowSource: "default",
    });
  });

  it("accepts boundary capacities and rejects conflicting input aliases", () => {
    for (const value of [8192, 4000000]) {
      const parsed = parseModelDetails(
        JSON.stringify({ id: "model", context_length: value }),
        "openai_chat",
      );
      assert.ok(parsed.ok);
      assert.equal(parsed.model.contextWindow, value);
    }
    for (const fields of [
      { max_input_tokens: 65536, input_token_limit: 131072 },
      { context_length: "invalid", max_input_tokens: 65536 },
    ]) {
      const parsed = parseModelDetails(JSON.stringify({ id: "model", ...fields }), "openai_chat");
      assert.ok(parsed.ok);
      assert.equal(parsed.model.contextWindowInvalid, true);
    }
  });
});
