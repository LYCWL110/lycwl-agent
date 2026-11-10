import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addCustomModel,
  applyKey,
  type BrowserState,
  clearReasoningDeclarations,
  createBrowserState,
  filteredModels,
  mergeFetchedModels,
  reasoningChoices,
  visibleWindow,
} from "../../src/tui/config-browser.ts";
import {
  colorFor,
  detectCapabilities,
  gradientWorthDrawing,
  rowStyle,
} from "../../src/tui/palette.ts";

/**
 * The browser is a pure reducer, so every rule is testable without a terminal.
 *
 * Modelled on the Miyu reference's ProviderBrowser: three columns, independent
 * scrolling, a filter mode, a status line that distinguishes information from error,
 * and an undoable delete.
 */

function state(overrides: Partial<BrowserState> = {}): BrowserState {
  const base = createBrowserState({
    providerLabel: "anthropic",
    protocols: ["anthropic_messages", "openai_chat", "openai_responses"],
    currentProtocol: "anthropic_messages",
    models: ["claude-a", "claude-b"],
    currentModel: "claude-a",
  });
  return { ...base, ...overrides };
}

describe("browser navigation", () => {
  it("starts on the protocol column with the current values selected", () => {
    const s = state();
    assert.equal(s.activeColumn, "protocol");
    assert.equal(s.protocols[s.protocolIndex], "anthropic_messages");
    assert.equal(s.models[s.modelIndex]?.id, "claude-a");
  });

  it("moves between columns with tab and arrows", () => {
    let s = state();
    s = applyKey(s, "tab").state;
    assert.equal(s.activeColumn, "model");
    s = applyKey(s, "right").state;
    assert.equal(s.activeColumn, "reasoning");
    s = applyKey(s, "right").state;
    assert.equal(s.activeColumn, "provider");
    s = applyKey(s, "left").state;
    assert.equal(s.activeColumn, "reasoning");
    s = applyKey(s, "left").state;
    assert.equal(s.activeColumn, "model");
  });

  it("moves the protocol selection without leaving the column", () => {
    const outcome = applyKey(state(), "down");
    assert.equal(outcome.state.activeColumn, "protocol");
    assert.equal(outcome.state.protocols[outcome.state.protocolIndex], "openai_chat");
  });

  it("clamps at the ends instead of wrapping", () => {
    let s = state();
    s = applyKey(s, "up").state;
    assert.equal(s.protocolIndex, 0);
    s = applyKey(applyKey(applyKey(s, "down").state, "down").state, "down").state;
    assert.equal(s.protocolIndex, 2);
  });

  it("scrolls the window to keep the cursor visible", () => {
    const models = Array.from({ length: 20 }, (_unused, index) => `m${index}`);
    let s = state({
      models: models.map((id) => ({ id, source: "custom" as const })),
      activeColumn: "model",
    });
    for (let index = 0; index < 12; index += 1) s = applyKey(s, "down").state;
    assert.equal(s.modelIndex, 12);
    // The cursor must be inside the visible window.
    const window = visibleWindow(filteredModels(s), s.scroll.model);
    assert.equal(
      window.some((entry) => entry.id === "m12"),
      true,
    );
  });
});

describe("reasoning column", () => {
  it("offers only default when support is unknown and ignores the old manual shortcut", () => {
    let s = state({ protocolIndex: 1, activeColumn: "reasoning", reasoningEffort: "high" });
    assert.deepEqual(reasoningChoices(s), ["default"]);
    assert.equal(applyKey(s, "enter").commit, null);
    assert.equal(applyKey(s, "enter").state.reasoningEffort, "high");
    s = applyKey(s, { kind: "text", value: "m" }).state;
    assert.deepEqual(reasoningChoices(s), ["default"]);
    assert.equal(applyKey(s, "enter").commit, null);
    assert.equal(applyKey(s, "up").state.reasoningEffort, "default");
  });

  it("requires a listed choice before saving a previously configured unknown effort", () => {
    const s = state({
      protocolIndex: 2,
      activeColumn: "reasoning",
      models: [{ id: "deepseek-v4.1-flash", source: "custom" }],
      reasoningEffort: "xhigh",
    });
    assert.deepEqual(reasoningChoices(s), ["default"]);
    assert.equal(s.reasoningEffort, "xhigh");
    assert.equal(applyKey(s, "enter").commit, null);
    const selected = applyKey(s, "down").state;
    assert.equal(selected.reasoningEffort, "default");
    assert.deepEqual(applyKey(selected, "enter").commit, {
      protocol: "openai_responses",
      model: "deepseek-v4.1-flash",
    });
  });

  it("does not restore unknown levels when navigating or refreshing metadata", () => {
    const selected = applyKey(
      state({
        protocolIndex: 2,
        activeColumn: "reasoning",
      }),
      "down",
    ).state;
    for (const next of [
      applyKey(selected, "left").state,
      applyKey(selected, "tab").state,
      clearReasoningDeclarations(selected),
      mergeFetchedModels(selected, ["claude-a"]),
    ]) {
      assert.deepEqual(reasoningChoices(next), ["default"]);
    }
    assert.equal(
      applyKey(applyKey(selected, "up").state, "enter").commit?.reasoningEffort,
      undefined,
    );
  });

  it("ignores the old manual shortcut for declared and reference model identities", () => {
    for (const s of [
      mergeFetchedModels(state(), [{ id: "claude-a", reasoning: { efforts: [] } }]),
      mergeFetchedModels(state(), [{ id: "claude-a", reasoning: { efforts: ["low"] } }]),
      state({ protocolIndex: 2, models: [{ id: "gpt-5.2", source: "custom" }] }),
    ]) {
      assert.equal(applyKey(s, { kind: "text", value: "m" }).state, s);
    }
  });

  it("limits both arrows and r to declared levels, and prevents manual broadening", () => {
    let s = mergeFetchedModels(state({ protocolIndex: 1, activeColumn: "reasoning" }), [
      { id: "claude-a", reasoning: { efforts: ["low", "high"] } },
    ]);
    assert.equal(s.models[0]?.source, "custom");
    assert.deepEqual(reasoningChoices(s), ["default", "low", "high"]);
    s = applyKey(s, "down").state;
    assert.equal(s.reasoningEffort, "low");
    s = applyKey(s, { kind: "text", value: "r" }).state;
    assert.equal(s.reasoningEffort, "high");
    s = applyKey(s, { kind: "text", value: "m" }).state;
    assert.deepEqual(reasoningChoices(s), ["default", "low", "high"]);
    s = applyKey(s, { kind: "text", value: "r" }).state;
    assert.equal(s.reasoningEffort, "default");
  });

  it("does not expose declarations marked invalid even if values are also present", () => {
    const s = mergeFetchedModels(state(), [
      { id: "claude-a", reasoningInvalid: true, reasoning: { efforts: ["high"] } },
    ]);
    assert.deepEqual(reasoningChoices(s), ["default"]);
  });

  it("updates levels for model selection, filter edits and protocol changes", () => {
    let s = mergeFetchedModels(state({ protocolIndex: 1, activeColumn: "model" }), [
      { id: "claude-a", reasoning: { efforts: ["low", "high"] } },
      { id: "claude-b", reasoning: { efforts: [] } },
    ]);
    s = { ...s, reasoningEffort: "high" };
    s = applyKey(s, "down").state;
    assert.deepEqual(reasoningChoices(s), ["default"]);
    assert.equal(applyKey(s, "enter").commit, null);
    s = applyKey(s, { kind: "text", value: "/" }).state;
    s = applyKey(s, { kind: "text", value: "claude-a" }).state;
    assert.deepEqual(reasoningChoices(s), ["default", "low", "high"]);
    s = applyKey(s, "escape").state;
    s = { ...s, activeColumn: "protocol" };
    s = applyKey(s, "down").state;
    assert.equal(s.models[0]?.reasoning, undefined);
    assert.deepEqual(reasoningChoices(s), ["default"]);
    assert.equal(applyKey(s, "undo").state.models[0]?.reasoning, undefined);
  });

  it("clears declarations on refresh and does not infer support for another model", () => {
    let s = state({ protocolIndex: 1, activeColumn: "model" });
    s = applyKey(s, { kind: "text", value: "m" }).state;
    assert.deepEqual(reasoningChoices(s), ["default"]);
    s = applyKey(s, "down").state;
    assert.deepEqual(reasoningChoices(s), ["default"]);
    s = applyKey(s, "up").state;
    s = mergeFetchedModels(s, ["claude-a"]);
    assert.deepEqual(reasoningChoices(s), ["default"]);
    s = mergeFetchedModels(s, [{ id: "claude-a", reasoning: { efforts: ["low"] } }]);
    assert.deepEqual(reasoningChoices(s), ["default", "low"]);
    s = clearReasoningDeclarations(s);
    assert.deepEqual(reasoningChoices(s), ["default"]);
    s = mergeFetchedModels(s, ["claude-a"]);
    assert.equal(s.models[0]?.reasoning, undefined);
  });

  for (const protocolIndex of [1, 2]) {
    it(`selects all reasoning levels with arrows for protocol ${protocolIndex}`, () => {
      let s = mergeFetchedModels(state({ protocolIndex, activeColumn: "model" }), [
        {
          id: "claude-a",
          reasoning: { efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
        },
      ]);
      s = applyKey(s, "right").state;
      assert.equal(s.activeColumn, "reasoning");
      assert.equal(applyKey(s, "up").state.reasoningEffort, "default");
      for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        s = applyKey(s, "down").state;
        assert.equal(s.reasoningEffort, effort);
        assert.equal(s.modelIndex, 0);
        assert.equal(applyKey(s, "enter").commit?.reasoningEffort, effort);
      }
      assert.equal(applyKey(s, "down").state.reasoningEffort, "max");
      s = applyKey(s, "up").state;
      assert.equal(s.reasoningEffort, "xhigh");
      assert.equal(applyKey(s, "left").state.activeColumn, "model");
    });
  }
  it("selects Anthropic's declared levels without offering OpenAI-only values", () => {
    const s = mergeFetchedModels(state({ activeColumn: "reasoning" }), [
      { id: "claude-a", reasoning: { efforts: ["none", "minimal", "low", "high", "max"] } },
    ]);
    assert.deepEqual(reasoningChoices(s), ["default", "low", "high", "max"]);
    const next = applyKey(s, "down").state;
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.modelIndex, s.modelIndex);
    assert.equal(applyKey(next, "enter").commit?.reasoningEffort, "low");
  });
});

describe("browser commit and cancel", () => {
  it("requires new declarations or default after switching protocols", () => {
    let s = mergeFetchedModels(state({ protocolIndex: 1, reasoningEffort: "medium" }), [
      { id: "claude-a", reasoning: { efforts: ["medium", "high"] } },
    ]);
    s = applyKey(s, { kind: "text", value: "r" }).state;
    assert.equal(s.reasoningEffort, "high");
    assert.equal(applyKey(s, "enter").commit?.reasoningEffort, "high");
    s = applyKey(s, "up").state;
    assert.equal(s.reasoningEffort, "high");
    assert.equal(applyKey(s, "enter").commit, null);
    s = applyKey(s, { kind: "text", value: "r" }).state;
    assert.equal(s.reasoningEffort, "default");
    s = applyKey(s, { kind: "text", value: "m" }).state;
    s = applyKey(s, { kind: "text", value: "r" }).state;
    assert.equal(s.reasoningEffort, "default");
  });

  it("commits the selected protocol and model", () => {
    let s = state();
    s = applyKey(s, "down").state; // openai_chat
    s = applyKey(s, "tab").state; // model column
    s = applyKey(s, "down").state; // claude-b
    const outcome = applyKey(s, "enter");
    assert.deepEqual(outcome.commit, { protocol: "openai_chat", model: "claude-b" });
    assert.equal(outcome.cancel, false);
  });

  it("cancels on escape", () => {
    const outcome = applyKey(state(), "escape");
    assert.equal(outcome.cancel, true);
    assert.equal(outcome.commit, null);
  });

  it("refuses to commit without a model", () => {
    const s = state({ models: [] });
    const outcome = applyKey(s, "enter");
    assert.equal(outcome.commit, null);
    assert.equal(outcome.state.status?.isError, true);
  });
});

describe("browser filter", () => {
  it("captures typed text in filter mode and narrows the list", () => {
    let s = state({ filterMode: true });
    s = applyKey(s, { kind: "text", value: "b" }).state;
    assert.equal(s.filter, "b");
    assert.deepEqual(
      filteredModels(s).map((entry) => entry.id),
      ["claude-b"],
    );
  });

  it("ignores typed text outside filter mode", () => {
    const s = state();
    const outcome = applyKey(s, { kind: "text", value: "x" });
    assert.equal(outcome.state.filter, "");
  });

  it("escape in filter mode clears the filter instead of closing", () => {
    const outcome = applyKey(state({ filterMode: true, filter: "a" }), "escape");
    assert.equal(outcome.cancel, false);
    assert.equal(outcome.state.filterMode, false);
    assert.equal(outcome.state.filter, "");
  });

  it("backspace shortens the filter", () => {
    let s = state({ filterMode: true, filter: "ab", filterCursor: 2 });
    s = applyKey(s, "backspace").state;
    assert.equal(s.filter, "a");
  });
});

describe("browser delete and undo", () => {
  it("removes a custom model and records an undo snapshot", () => {
    const outcome = applyKey(state({ activeColumn: "model" }), "delete");
    assert.equal(
      outcome.state.models.some((entry) => entry.id === "claude-a"),
      false,
    );
    assert.ok(outcome.state.undo !== null);
    assert.equal(outcome.state.status?.isError, false);
  });

  it("refuses to remove a fetched model", () => {
    const s = state({
      activeColumn: "model",
      models: [{ id: "fetched-1", source: "fetched" }],
      modelIndex: 0,
    });
    const outcome = applyKey(s, "delete");
    assert.equal(outcome.state.models.length, 1);
    assert.equal(outcome.state.status?.isError, true);
  });

  it("undo restores the removed model exactly once", () => {
    const first = applyKey(state({ activeColumn: "model" }), "delete");
    assert.ok(first.state.undo !== null);

    const restored = applyKey(first.state, "undo");
    assert.equal(
      restored.state.models.some((entry) => entry.id === "claude-a"),
      true,
    );
    // A second undo has nothing left to restore.
    assert.equal(restored.state.undo, null);
    const again = applyKey(restored.state, "undo");
    assert.equal(again.state.status?.isError, false);
    assert.match(again.state.status?.text ?? "", /nothing to undo/);
  });
});

describe("browser model merging", () => {
  it("adds a custom model once", () => {
    const s = addCustomModel(state(), "new-model");
    assert.equal(
      s.models.some((entry) => entry.id === "new-model"),
      true,
    );
    const again = addCustomModel(s, "new-model");
    assert.equal(again.models.length, s.models.length);
    assert.match(again.status?.text ?? "", /already listed/);
  });

  it("rejects an empty or over-long name", () => {
    assert.equal(addCustomModel(state(), "  ").status?.isError, true);
    assert.equal(addCustomModel(state(), "x".repeat(300)).status?.isError, true);
  });

  it("keeps custom entries ahead of fetched ones and deduplicates", () => {
    const s = mergeFetchedModels(state(), ["claude-a", "fetched-x"]);
    const ids = s.models.map((entry) => entry.id);
    // The duplicate is not added twice.
    assert.equal(ids.filter((id) => id === "claude-a").length, 1);
    assert.equal(ids.includes("fetched-x"), true);
    // The custom entries keep their position at the front.
    assert.deepEqual(ids.slice(0, 2), ["claude-a", "claude-b"]);
    assert.equal(s.models.at(-1)?.source, "fetched");
  });
});

describe("palette degradation", () => {
  it("recognizes Windows Terminal even when TERM is absent", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: undefined,
      force: undefined,
      windowsTerminal: true,
    });
    assert.equal(caps.depth, "truecolor");
    assert.equal(
      detectCapabilities({
        noColor: true,
        colorterm: undefined,
        term: undefined,
        force: "truecolor",
        windowsTerminal: true,
      }).depth,
      "mono",
    );
  });
  it("honours NO_COLOR over everything", () => {
    const caps = detectCapabilities({
      noColor: true,
      colorterm: "truecolor",
      term: "xterm-kitty",
      force: "truecolor",
    });
    assert.equal(caps.depth, "mono");
    assert.equal(colorFor("primary", caps), undefined);
  });

  it("detects truecolor from COLORTERM", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: "24bit",
      term: undefined,
      force: undefined,
    });
    assert.equal(caps.depth, "truecolor");
  });

  it("detects a modern terminal without COLORTERM", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: "xterm-kitty",
      force: undefined,
    });
    assert.equal(caps.depth, "truecolor");
  });

  it("falls back to 16 colours for an unknown terminal", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: "xterm",
      force: undefined,
    });
    assert.equal(caps.depth, "ansi16");
    assert.equal(colorFor("primary", caps), "cyan");
  });

  it("treats an empty TERM as monochrome", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: "",
      force: undefined,
    });
    assert.equal(caps.depth, "mono");
  });

  it("lets a forced depth win over detection", () => {
    const caps = detectCapabilities({
      noColor: false,
      colorterm: "truecolor",
      term: "xterm-kitty",
      force: "16",
    });
    assert.equal(caps.depth, "ansi16");
  });

  it("draws a gradient only where it reads as one", () => {
    const truecolor = detectCapabilities({
      noColor: false,
      colorterm: "truecolor",
      term: undefined,
      force: undefined,
    });
    const ansi = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: "xterm",
      force: undefined,
    });
    assert.equal(gradientWorthDrawing(truecolor), true);
    assert.equal(gradientWorthDrawing(ansi), false);
  });

  it("uses reverse video for focus when colour is scarce", () => {
    const ansi = detectCapabilities({
      noColor: false,
      colorterm: undefined,
      term: "xterm",
      force: undefined,
    });
    const focused = rowStyle({ role: "primary", focused: true, capabilities: ansi });
    assert.equal(focused.inverse, true);

    const truecolor = detectCapabilities({
      noColor: false,
      colorterm: "truecolor",
      term: undefined,
      force: undefined,
    });
    const rich = rowStyle({ role: "primary", focused: true, capabilities: truecolor });
    assert.equal(rich.inverse, false);
    assert.match(String(rich.color), /^#[0-9a-f]{6}$/);
  });
});
