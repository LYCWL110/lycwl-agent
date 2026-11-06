/**
 * Provider configuration browser.
 *
 * Modelled on the Miyu reference's `ProviderBrowser` (`src/config_tui/providers.rs`):
 * three columns — provider, protocol, model — with independent cursors and scroll
 * offsets, a filter mode, a status line that distinguishes information from error,
 * and an undoable delete.
 *
 * The state is a pure reducer over key events so every rule below is testable
 * without a terminal. The renderer reads this state; it does not own it.
 */

export const BROWSER_LIMITS = Object.freeze({
  /** Rows visible per column; scrolling keeps the cursor inside the window. */
  visibleRows: 8,
  maxModelLength: 200,
});

export type Column = "provider" | "protocol" | "model";

export const COLUMNS: readonly Column[] = Object.freeze(["provider", "protocol", "model"]);

export type ModelEntry = Readonly<{
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
  models: readonly ModelEntry[];
  modelIndex: number;
  activeColumn: Column;
  /** Row offsets per column, so each column scrolls independently. */
  scroll: Readonly<Record<Column, number>>;
  filter: string;
  filterMode: boolean;
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
    models,
    modelIndex,
    activeColumn: "protocol",
    scroll: { provider: 0, protocol: 0, model: 0 },
    filter: "",
    filterMode: false,
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
  | { kind: "text"; value: string };

export type BrowserOutcome = Readonly<{
  state: BrowserState;
  /** Set when the browser should close and apply this configuration. */
  commit: Readonly<{ protocol: string; model: string }> | null;
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
  if (typeof key === "object") {
    if (!state.filterMode) return { state, commit: null, cancel: false };
    return {
      state: { ...state, filter: state.filter + key.value },
      commit: null,
      cancel: false,
    };
  }

  if (key === "escape") {
    if (state.filterMode) {
      return { state: { ...state, filterMode: false, filter: "" }, commit: null, cancel: false };
    }
    return { state, commit: null, cancel: true };
  }

  if (key === "tab") {
    const index = COLUMNS.indexOf(state.activeColumn);
    const next = COLUMNS[(index + 1) % COLUMNS.length] ?? "protocol";
    return { state: { ...state, activeColumn: next }, commit: null, cancel: false };
  }

  if (key === "undo") {
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
    return {
      state,
      commit: {
        protocol: state.protocols[state.protocolIndex] ?? "",
        model: model.id,
      },
      cancel: false,
    };
  }

  if (key === "backspace") {
    if (!state.filterMode) return { state, commit: null, cancel: false };
    return {
      state: { ...state, filter: [...state.filter].slice(0, -1).join("") },
      commit: null,
      cancel: false,
    };
  }

  if (key === "delete") {
    return deleteSelectedModel(state);
  }

  // Movement keys.
  if (key === "left" || key === "right") {
    const index = COLUMNS.indexOf(state.activeColumn);
    const delta = key === "left" ? -1 : 1;
    const next = COLUMNS[(index + delta + COLUMNS.length) % COLUMNS.length] ?? "protocol";
    return { state: { ...state, activeColumn: next }, commit: null, cancel: false };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (state.activeColumn === "protocol") {
      const next = clamp(state.protocolIndex + delta, 0, state.protocols.length - 1);
      return {
        state: { ...state, protocolIndex: next, scroll: scrollTo(state.scroll, "protocol", next) },
        commit: null,
        cancel: false,
      };
    }
    if (state.activeColumn === "model") {
      const visible = filteredModels(state).length;
      const next = clamp(state.modelIndex + delta, 0, Math.max(0, visible - 1));
      return {
        state: { ...state, modelIndex: next, scroll: scrollTo(state.scroll, "model", next) },
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
export function mergeFetchedModels(state: BrowserState, fetched: readonly string[]): BrowserState {
  const seen = new Set(state.models.map((entry) => entry.id));
  const added: ModelEntry[] = [];
  for (const id of fetched) {
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({ id, source: "fetched" });
  }
  return {
    ...state,
    models: [...state.models, ...added],
    status: {
      text: added.length === 0 ? "no new models" : `fetched ${added.length} model(s)`,
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
