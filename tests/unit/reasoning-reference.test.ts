import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { parseModelList } from "../../src/adapters/providers/model-list.ts";
import { protocolReasoningEfforts } from "../../src/domain/config/provider-config.ts";
import {
  REASONING_REFERENCE_SOURCE,
  REASONING_REFERENCES,
  referenceReasoningFor,
} from "../../src/domain/config/reasoning-reference.ts";
import {
  applyKey,
  clearReasoningDeclarations,
  createBrowserState,
  mergeFetchedModels,
  reasoningChoices,
  reasoningNotice,
} from "../../src/tui/config-browser.ts";

function browser(model = "gpt-5.2", protocol = "openai_responses") {
  return {
    ...createBrowserState({
      providerLabel: "relay",
      protocols: ["openai_responses", "openai_chat", "anthropic_messages"],
      currentProtocol: protocol,
      models: [model],
      currentModel: model,
    }),
    activeColumn: "reasoning" as const,
  };
}

describe("frozen reasoning references", () => {
  it("retains the independently extracted 44-model projection and its digest", () => {
    const projection = [...REASONING_REFERENCES]
      .sort((a, b) => {
        if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((entry) => ({
        provider: entry.provider,
        id: entry.id,
        protocols: entry.protocols,
        efforts: entry.efforts,
      }));
    assert.equal(projection.length, 44);
    assert.equal(
      createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
      REASONING_REFERENCE_SOURCE.projectionSha256,
    );
    assert.ok(Object.isFrozen(REASONING_REFERENCES));
    assert.equal(new Set(projection.map((entry) => `${entry.provider}/${entry.id}`)).size, 44);
    for (const entry of REASONING_REFERENCES) {
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.efforts));
      assert.ok(Object.isFrozen(entry.protocols));
      for (const protocol of entry.protocols)
        for (const effort of entry.efforts)
          assert.ok(protocolReasoningEfforts(protocol).includes(effort));
    }
  });

  it("keeps reference identities out of selectable levels without upstream declarations", () => {
    const expected = ["none", "low", "medium", "high", "xhigh"];
    for (const id of ["gpt-5.2", "openai/gpt-5.2"]) {
      const state = browser(id);
      assert.deepEqual(referenceReasoningFor("openai_responses", id)?.efforts, expected);
      assert.deepEqual(reasoningChoices(state), ["default"]);
      assert.equal(reasoningNotice(state), "No upstream levels; default only");
      const selected = applyKey(state, "down").state;
      assert.equal(applyKey(selected, "enter").commit?.model, id);
      assert.equal(selected.models[0]?.reasoning, undefined);
    }
  });

  it("hides reference values in all three implemented protocols", () => {
    for (const [id, protocol] of [
      ["gpt-5", "openai_chat"],
      ["gpt-5.2-pro", "openai_responses"],
      ["claude-opus-4-6", "anthropic_messages"],
      ["deepseek-v4-pro", "openai_chat"],
    ]) {
      assert.deepEqual(reasoningChoices(browser(id, protocol)), ["default"]);
    }
  });

  it("does not infer aliases, family versions, namespaces, budgets or other protocols", () => {
    for (const id of [
      "relay/gpt-5.2",
      "other/openai/gpt-5.2",
      "gpt-5.2-custom",
      "GPT-5.2",
      "gpt-5.2-20261107",
      "claude-sonnet-4-5",
      "unknown",
      "__proto__",
    ])
      assert.equal(referenceReasoningFor("openai_responses", id), undefined);
    for (const [protocol, id] of [
      ["anthropic_messages", "gpt-5.2"],
      ["openai_chat", "gpt-5.2-pro"],
      ["openai_responses", "claude-opus-4-6"],
      ["unknown", "gpt-5.2"],
      ["anthropic_messages", "claude-sonnet-4-5"],
    ])
      assert.equal(referenceReasoningFor(protocol ?? "", id ?? ""), undefined);
    assert.deepEqual(reasoningChoices(browser("alias")), ["default"]);
    const manual = applyKey(browser("alias"), { kind: "text", value: "m" }).state;
    assert.equal(reasoningNotice(manual), "No upstream levels; default only");
    assert.deepEqual(reasoningChoices(manual), ["default"]);
  });

  it("keeps explicit restrictions and empty lists ahead of references and manual mode", () => {
    for (const efforts of [[], ["low"]] as const) {
      let state = mergeFetchedModels(browser(), [{ id: "gpt-5.2", reasoning: { efforts } }]);
      state = applyKey(state, { kind: "text", value: "m" }).state;
      assert.deepEqual(reasoningChoices(state), ["default", ...efforts]);
      assert.notEqual(reasoningNotice(state), "Reference levels (unverified)");
    }
  });

  it("prevents m from exposing reference choices and retains invalid saved choices", () => {
    const original = browser("gpt-5.2-pro");
    const state = applyKey(original, { kind: "text", value: "m" }).state;
    assert.equal(state, original);
    assert.deepEqual(reasoningChoices(state), ["default"]);
    const invalid = { ...state, reasoningEffort: "max" as const };
    assert.equal(applyKey(invalid, "enter").commit, null);
    assert.equal(applyKey(invalid, "enter").state.reasoningEffort, "max");
  });

  it("preserves malformed/conflicting declarations through parsing and blocks fallback", () => {
    for (const data of [
      [{ id: "gpt-5.2", supported_reasoning_efforts: "high" }],
      [{ id: "gpt-5.2", effort: { supported_levels: null } }],
      [
        { id: "gpt-5.2", supported_reasoning_efforts: ["low"] },
        { id: "gpt-5.2", supported_reasoning_efforts: ["high"] },
        { id: "gpt-5.2" },
      ],
    ]) {
      const result = parseModelList(JSON.stringify({ data }), "openai_responses");
      assert.ok(result.ok && result.catalog);
      const state = mergeFetchedModels(browser(), result.catalog);
      assert.equal(state.models[0]?.reasoningInvalid, true);
      assert.deepEqual(reasoningChoices(state), ["default"]);
      assert.equal(reasoningNotice(state), "No upstream levels; default only");
    }
  });

  it("does not revive declarations or reference choices on refresh and protocol changes", () => {
    let state = mergeFetchedModels(browser("gpt-5.2-pro"), [
      { id: "gpt-5.2-pro", reasoning: { efforts: ["high"] } },
    ]);
    state = clearReasoningDeclarations(state);
    assert.deepEqual(reasoningChoices(state), ["default"]);
    state = { ...state, activeColumn: "protocol" };
    state = applyKey(state, "down").state;
    assert.deepEqual(reasoningChoices(state), ["default"]);
    assert.equal(state.models[0]?.reasoning, undefined);
  });
});
