/**
 * Provider configuration browser.
 *
 * Adapts Miyu's provider/group/model browser (`src/config_tui/providers.rs`) into
 * provider/protocol/model/reasoning columns, with independent cursors and scroll
 * offsets, a filter mode, a status line that distinguishes information from error,
 * and an undoable delete.
 *
 * The state is a pure reducer over key events so every rule below is testable
 * without a terminal. The renderer reads this state; it does not own it.
 */

import type { CatalogModel } from "../domain/config/model-catalog.ts";
import { resolveModelContext } from "../domain/config/model-context.ts";
import {
  protocolReasoningEfforts,
  type ReasoningEffort,
} from "../domain/config/provider-config.ts";
import { characters, editText } from "./text-edit.ts";

export const BROWSER_LIMITS = Object.freeze({
  /** Rows visible per column; scrolling keeps the cursor inside the window. */
  visibleRows: 8,
  maxModelLength: 200,
});

export type Column = "provider" | "protocol" | "model" | "reasoning";

export const COLUMNS: readonly Column[] = Object.freeze([
  "provider",
  "protocol",
  "model",
  "reasoning",
]);

export type ModelEntry = CatalogModel &
  Readonly<{
    /** Identifier sent to the provider. */
    id: string;
    /** Where the entry came from, so a fetched model is not mistaken for a custom one. */
    source: "custom" | "fetched";
  }>;

export type BrowserState = Readonly<{
  /** Fixed for now: one provider identity is configured per Session. */
  providerLabel: string;
  protocols: readonly string[];
  protocolIndex: number;
  reasoningEffort: ReasoningEffort;
  models: readonly ModelEntry[];
  modelIndex: number;
  activeColumn: Column;
  /** Row offsets per column, so each column scrolls independently. */
  scroll: Readonly<Record<Column, number>>;
  filter: string;
  filterMode: boolean;
  filterCursor: number;
  modelInput: string | null;
  modelCursor: number;
  status: Readonly<{ text: string; isError: boolean }> | null;
  /** A snapshot taken before a destructive action, for a single-step undo. */
  undo: BrowserState | null;
}>;

export type BrowserSeed = Readonly<{
  providerLabel: string;
  protocols: readonly string[];
  currentProtocol: string;
  models: readonly string[];
  currentModel: string;
  reasoningEffort?: ReasoningEffort;
}>;

export function createBrowserState(seed: BrowserSeed): BrowserState {
  const protocolIndex = Math.max(0, seed.protocols.indexOf(seed.currentProtocol));
  const models: ModelEntry[] = seed.models.map((id) => ({ id, source: "custom" }));
  const modelIndex = Math.max(
    0,
    models.findIndex((entry) => entry.id === seed.currentModel),
  );
  return {
    providerLabel: seed.providerLabel,
    protocols: seed.protocols,
    protocolIndex,
    reasoningEffort: seed.reasoningEffort ?? "default",
    models,
    modelIndex,
    activeColumn: "protocol",
    scroll: { provider: 0, protocol: 0, model: 0, reasoning: 0 },
    filter: "",
    filterMode: false,
    filterCursor: 0,
    modelInput: null,
    modelCursor: 0,
    status: null,
    undo: null,
  };
}

export type BrowserKey =
  | "left"
  | "right"
  | "up"
  | "down"
  | "tab"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "undo"
  | "home"
  | "end"
  | "clear"
  | { kind: "text"; value: string };

export type BrowserOutcome = Readonly<{
  state: BrowserState;
  /** Set when the browser should close and apply this configuration. */
  commit: Readonly<{ protocol: string; model: string; reasoningEffort?: ReasoningEffort }> | null;
  /** Set when the browser should close without applying. */
  cancel: boolean;
}>;

/**
 * Apply one key.
 *
 * Filter mode captures every printable character, so typing a model name cannot
 * accidentally move the cursor or commit.
 */
export function applyKey(state: BrowserState, key: BrowserKey): BrowserOutcome {
  if (
    (state.modelInput !== null || state.filterMode) &&
    !["enter", "escape", "tab", "up", "down", "undo"].includes(typeof key === "string" ? key : "")
  ) {
    const model = state.modelInput !== null;
    const edited = editText(
      {
        value: model ? (state.modelInput ?? "") : state.filter,
        cursor: model ? state.modelCursor : state.filterCursor,
      },
      typeof key === "object" ? key.value : key === "clear" ? "u" : "",
      typeof key === "object"
        ? {}
        : {
            leftArrow: key === "left",
            rightArrow: key === "right",
            home: key === "home",
            end: key === "end",
            backspace: key === "backspace",
            delete: key === "delete",
            ctrl: key === "clear",
          },
    );
    if (model && edited.value.length > BROWSER_LIMITS.maxModelLength)
      return {
        state: withStatus(state, "model name is too long", true),
        commit: null,
        cancel: false,
      };
    return {
      state: model
        ? { ...state, modelInput: edited.value, modelCursor: edited.cursor }
        : {
            ...state,
            filter: edited.value,
            filterCursor: edited.cursor,
            modelIndex: 0,
            scroll: { ...state.scroll, model: 0 },
          },
      commit: null,
      cancel: false,
    };
  }
  if (typeof key === "object") {
    if (key.value === "r") {
      const choices = reasoningChoices(state);
      const index = choices.indexOf(state.reasoningEffort);
      return {
        state: {
          ...state,
          reasoningEffort: choices[(index + 1) % choices.length] ?? "default",
        },
        commit: null,
        cancel: false,
      };
    }
    if (key.value === "/") {
      return {
        state: {
          ...state,
          filterMode: true,
          filterCursor: characters(state.filter).length,
          activeColumn: "model",
        },
        commit: null,
        cancel: false,
      };
    }
    if (key.value === "a" && state.activeColumn === "model") {
      return {
        state: { ...state, modelInput: "", modelCursor: 0, status: null },
        commit: null,
        cancel: false,
      };
    }
    return { state, commit: null, cancel: false };
  }

  if (key === "escape") {
    if (state.modelInput !== null) {
      return { state: { ...state, modelInput: null }, commit: null, cancel: false };
    }
    if (state.filterMode) {
      return {
        state: {
          ...state,
          filterMode: false,
          filter: "",
          modelIndex: 0,
          scroll: { ...state.scroll, model: 0 },
        },
        commit: null,
        cancel: false,
      };
    }
    return { state, commit: null, cancel: true };
  }

  if (key === "tab") {
    if (state.modelInput !== null || state.filterMode)
      return { state, commit: null, cancel: false };
    const index = COLUMNS.indexOf(state.activeColumn);
    const next = COLUMNS[(index + 1) % COLUMNS.length] ?? "protocol";
    return {
      state: { ...state, activeColumn: next },
      commit: null,
      cancel: false,
    };
  }

  if (key === "undo") {
    if (state.modelInput !== null || state.filterMode)
      return { state, commit: null, cancel: false };
    if (state.undo === null) {
      return {
        state: withStatus(state, "nothing to undo", false),
        commit: null,
        cancel: false,
      };
    }
    // Restoring the snapshot clears the undo slot so a second undo cannot walk
    // further back than one step.
    return { state: { ...state.undo, undo: null }, commit: null, cancel: false };
  }

  if (key === "enter") {
    if (state.modelInput !== null) {
      const added = addCustomModel(state, state.modelInput);
      if (added.status?.isError) return { state: added, commit: null, cancel: false };
      const next = added.models.findIndex((entry) => entry.id === state.modelInput?.trim());
      return {
        state: {
          ...added,
          modelInput: null,
          filter: "",
          modelIndex: next,
          scroll: scrollTo(added.scroll, "model", next),
        },
        commit: null,
        cancel: false,
      };
    }
    if (state.filterMode) {
      return { state: { ...state, filterMode: false }, commit: null, cancel: false };
    }
    const model = filteredModels(state)[state.modelIndex];
    if (model === undefined) {
      return {
        state: withStatus(state, "select a model first", true),
        commit: null,
        cancel: false,
      };
    }
    if (!reasoningChoices(state).includes(state.reasoningEffort)) {
      return {
        state: withStatus(state, "Select a listed reasoning level before saving", true),
        commit: null,
        cancel: false,
      };
    }
    return {
      state,
      commit: {
        protocol: state.protocols[state.protocolIndex] ?? "",
        model: model.id,
        ...(state.reasoningEffort === "default" ? {} : { reasoningEffort: state.reasoningEffort }),
      },
      cancel: false,
    };
  }

  if (key === "delete") {
    if (state.activeColumn !== "model" || state.modelInput !== null || state.filterMode) {
      return { state, commit: null, cancel: false };
    }
    return deleteSelectedModel(state);
  }

  if (state.modelInput !== null || state.filterMode) return { state, commit: null, cancel: false };
  // Movement keys.
  if (key === "left" || key === "right") {
    const index = COLUMNS.indexOf(state.activeColumn);
    const delta = key === "left" ? -1 : 1;
    const next = COLUMNS[(index + delta + COLUMNS.length) % COLUMNS.length] ?? "protocol";
    return {
      state: { ...state, activeColumn: next },
      commit: null,
      cancel: false,
    };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (state.activeColumn === "protocol") {
      const next = clamp(state.protocolIndex + delta, 0, state.protocols.length - 1);
      return {
        state: {
          ...state,
          protocolIndex: next,
          ...(next === state.protocolIndex
            ? {}
            : {
                models: state.models
                  .filter((entry) => entry.source === "custom")
                  .map(({ id, source }) => ({ id, source })),
                modelIndex: 0,
                filter: "",
                status: null,
                undo: null,
              }),
          scroll: {
            ...scrollTo(state.scroll, "protocol", next),
            model: next === state.protocolIndex ? state.scroll.model : 0,
          },
        },
        commit: null,
        cancel: false,
      };
    }
    if (state.activeColumn === "model") {
      const visible = filteredModels(state).length;
      const next = clamp(state.modelIndex + delta, 0, Math.max(0, visible - 1));
      return {
        state: {
          ...state,
          modelIndex: next,
          scroll: scrollTo(state.scroll, "model", next),
        },
        commit: null,
        cancel: false,
      };
    }
    if (state.activeColumn === "reasoning") {
      const choices = reasoningChoices(state);
      const index = clamp(choices.indexOf(state.reasoningEffort) + delta, 0, choices.length - 1);
      return {
        state: { ...state, reasoningEffort: choices[index] ?? "default" },
        commit: null,
        cancel: false,
      };
    }
    // The provider column has one entry in v1, so it cannot move.
    return { state, commit: null, cancel: false };
  }

  return { state, commit: null, cancel: false };
}

/** Models matching the current filter, in their original order. */
export function filteredModels(state: BrowserState): readonly ModelEntry[] {
  const needle = state.filter.trim().toLowerCase();
  if (needle.length === 0) return state.models;
  return state.models.filter((entry) => entry.id.toLowerCase().includes(needle));
}

export function reasoningChoices(state: BrowserState): readonly ReasoningEffort[] {
  const allowed = protocolReasoningEfforts(state.protocols[state.protocolIndex] ?? "");
  const model = filteredModels(state)[state.modelIndex];
  const declaration = model?.reasoningInvalid ? undefined : model?.reasoning;
  if (declaration !== undefined)
    return ["default", ...declaration.efforts.filter((effort) => allowed.includes(effort))];
  return ["default"];
}

export function reasoningNotice(state: BrowserState): string {
  const model = filteredModels(state)[state.modelIndex];
  const declaration = model?.reasoningInvalid ? undefined : model?.reasoning;
  if (declaration !== undefined)
    return declaration.efforts.length === 0
      ? "No selectable upstream effort levels"
      : declaration.defaultEffort === undefined
        ? "Upstream-declared levels"
        : `Upstream levels; default ${declaration.defaultEffort}`;
  return "No upstream levels; default only";
}

export function contextNotice(state: BrowserState, manual?: number): string {
  const selected = filteredModels(state)[state.modelIndex];
  const context = resolveModelContext(selected, manual);
  const source =
    context.contextWindowSource === "manual"
      ? "manual"
      : context.contextWindowSource === "upstream"
        ? "upstream-declared"
        : "default; not verified";
  return `Context: ${context.contextWindow.toLocaleString("en-US")} tokens (${source})`;
}

/** Refresh invalidates declarations and undo snapshots before a new request starts. */
export function clearReasoningDeclarations(state: BrowserState): BrowserState {
  return {
    ...state,
    models: state.models.map(({ id, source }) => ({ id, source })),
    undo: null,
  };
}

/**
 * Delete the selected model.
 *
 * Only a custom entry can be removed: a fetched entry belongs to the provider's
 * catalogue and is shown, not owned. The snapshot is kept so the delete can be
 * undone, because losing a hand-typed model name is a real loss.
 */
function deleteSelectedModel(state: BrowserState): BrowserOutcome {
  const visible = filteredModels(state);
  const selected = visible[state.modelIndex];
  if (selected === undefined) {
    return { state: withStatus(state, "nothing selected", true), commit: null, cancel: false };
  }
  if (selected.source === "fetched") {
    return {
      state: withStatus(state, "a fetched model cannot be removed here", true),
      commit: null,
      cancel: false,
    };
  }
  const models = state.models.filter((entry) => entry.id !== selected.id);
  const nextIndex = clamp(state.modelIndex, 0, Math.max(0, models.length - 1));
  return {
    state: {
      ...state,
      models,
      modelIndex: nextIndex,
      scroll: scrollTo(state.scroll, "model", nextIndex),
      status: { text: `removed ${selected.id}`, isError: false },
      undo: state,
    },
    commit: null,
    cancel: false,
  };
}

/** Add a model the user typed, unless it is already present. */
export function addCustomModel(state: BrowserState, id: string): BrowserState {
  const trimmed = id.trim();
  if (trimmed.length === 0) return withStatus(state, "a model name is required", true);
  if (trimmed.length > BROWSER_LIMITS.maxModelLength) {
    return withStatus(state, "model name is too long", true);
  }
  if (state.models.some((entry) => entry.id === trimmed)) {
    return withStatus(state, `${trimmed} is already listed`, false);
  }
  return {
    ...state,
    models: [...state.models, { id: trimmed, source: "custom" }],
    status: { text: `added ${trimmed}`, isError: false },
  };
}

/** Merge fetched model names, keeping custom entries first and deduplicating. */
export function mergeFetchedModels(
  state: BrowserState,
  fetched: readonly (string | CatalogModel)[],
): BrowserState {
  const incoming = new Map(
    fetched.map((entry) =>
      typeof entry === "string" ? ([entry, { id: entry }] as const) : ([entry.id, entry] as const),
    ),
  );
  const models = state.models.map(({ id, source }) => ({ ...incoming.get(id), id, source }));
  const seen = new Set(models.map((entry) => entry.id));
  for (const entry of incoming.values()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push({ ...entry, source: "fetched" });
  }
  const added = models.length - state.models.length;
  return {
    ...state,
    models,
    undo: null,
    status: {
      text: added === 0 ? "no new models" : `fetched ${added} model(s)`,
      isError: false,
    },
  };
}

/** Visible window for a column, honouring its scroll offset. */
export function visibleWindow<T>(
  items: readonly T[],
  scroll: number,
  rows: number = BROWSER_LIMITS.visibleRows,
): readonly T[] {
  return items.slice(scroll, scroll + rows);
}

function scrollTo(
  scroll: Readonly<Record<Column, number>>,
  column: Column,
  index: number,
): Readonly<Record<Column, number>> {
  const rows = BROWSER_LIMITS.visibleRows;
  const current = scroll[column];
  let next = current;
  if (index < current) next = index;
  if (index >= current + rows) next = index - rows + 1;
  return { ...scroll, [column]: Math.max(0, next) };
}

function withStatus(state: BrowserState, text: string, isError: boolean): BrowserState {
  return { ...state, status: { text, isError } };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
