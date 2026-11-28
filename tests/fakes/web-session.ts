import type { CoordinatorResult } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ProviderImage } from "../../src/ports/model-provider.ts";
import type { TuiController, TuiNavigationRequest } from "../../src/tui/controller.ts";
import type { McpPanelEntry } from "../../src/tui/mcp-panel.ts";
import { EMPTY_VIEW, type TuiViewState } from "../../src/tui/view-model.ts";
import type { WebAssetSource } from "../../src/web/assets.ts";
import type {
  WebSessionCatalog,
  WebSessionListEntry,
  WebSessionOpener,
  WebSessionRuntime,
} from "../../src/web/protocol.ts";
import { WebSessionError, type WebSessionHost } from "../../src/web/session-host.ts";

/**
 * Fakes for the web layer's seams.
 *
 * The web server's whole job is presentation: it reads `TuiViewState` snapshots
 * and calls the `TuiController` command surface. These fakes keep that seam
 * observable — every call is counted and recorded — so the tests can assert the
 * HTTP layer forwarded the command without reaching into the Runtime.
 */

/** An empty view with the given overrides; `EMPTY_VIEW` is the single source. */
export function emptyView(overrides: Partial<TuiViewState> = {}): TuiViewState {
  return { ...EMPTY_VIEW, ...overrides };
}

export type SubmitRecord = Readonly<{
  text: string;
  images?: readonly ProviderImage[];
}>;

export type RenameRecord = Readonly<{ sessionId: string; title: string | null }>;

/** Counters the fake mutates; the web layer only reads them through the handle. */
export type FakeControllerCalls = {
  submit: SubmitRecord[];
  approve: number;
  deny: number;
  answer: string[];
  declineQuestion: number;
  cancelRun: number;
  close: number;
  closePanel: number;
  confirmInit: number;
  addMcpServer: McpPanelEntry[];
  removeMcpServer: string[];
  renameSession: RenameRecord[];
  deleteSession: string[];
  deleteMemory: string[];
  correctCredential: string[];
  takeNavigationRequest: number;
};

export type FakeControllerHandle = Readonly<{
  /** The controller handed to the web layer. */
  controller: TuiController;
  /** Every command the web layer issued, in call order per method. */
  calls: FakeControllerCalls;
  /** Replace the view wholesale. */
  setView: (next: TuiViewState) => void;
  /** Merge fields into the current view. */
  patchView: (patch: Partial<TuiViewState>) => void;
  /** Read the current view (the same object `controller.view()` returns). */
  currentView: () => TuiViewState;
  /** Set what `lastResult()` reports. */
  setLastResult: (result: CoordinatorResult | null) => void;
  /** Queue a navigation request the fake will hand out once. */
  setNavigation: (request: TuiNavigationRequest | null) => void;
}>;

export type FakeControllerOptions = Readonly<{
  view?: TuiViewState;
  lastResult?: CoordinatorResult | null;
  /**
   * Called after a submit is recorded. Returning a value passes it through to the
   * caller (the web interface uses `boolean | undefined`). Tests use it to model a
   * Run starting, or to fail storage.
   */
  onSubmit?: (
    text: string,
    images: readonly ProviderImage[] | undefined,
    handle: FakeControllerHandle,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onApprove?: (handle: FakeControllerHandle) => void | Promise<void>;
  onDeny?: (handle: FakeControllerHandle) => void | Promise<void>;
  onAnswer?: (text: string, handle: FakeControllerHandle) => void | Promise<void>;
  onDeclineQuestion?: (handle: FakeControllerHandle) => void | Promise<void>;
  onCancelRun?: (handle: FakeControllerHandle) => void | Promise<void>;
  onClose?: (handle: FakeControllerHandle) => void | Promise<void>;
}>;

/**
 * A `TuiController` stub implementing every method.
 *
 * The default view is idle and empty. A test mutates it through `patchView` to
 * model the Runtime moving on; the web server samples `view()` so the next tick
 * sees the change.
 */
export function createFakeController(options: FakeControllerOptions = {}): FakeControllerHandle {
  let view = options.view ?? EMPTY_VIEW;
  let lastResult: CoordinatorResult | null = options.lastResult ?? null;
  let navigation: TuiNavigationRequest | null = null;

  const calls: FakeControllerCalls = {
    submit: [],
    approve: 0,
    deny: 0,
    answer: [],
    declineQuestion: 0,
    cancelRun: 0,
    close: 0,
    closePanel: 0,
    confirmInit: 0,
    addMcpServer: [],
    removeMcpServer: [],
    renameSession: [],
    deleteSession: [],
    deleteMemory: [],
    correctCredential: [],
    takeNavigationRequest: 0,
  };

  let handle: FakeControllerHandle;

  const controller: TuiController = {
    view: () => view,
    submit: async (text, images) => {
      calls.submit.push(images === undefined ? { text } : { text, images });
      return options.onSubmit === undefined ? undefined : options.onSubmit(text, images, handle);
    },
    approve: async () => {
      calls.approve += 1;
      await options.onApprove?.(handle);
    },
    deny: async () => {
      calls.deny += 1;
      await options.onDeny?.(handle);
    },
    answer: async (text) => {
      calls.answer.push(text);
      await options.onAnswer?.(text, handle);
    },
    declineQuestion: async () => {
      calls.declineQuestion += 1;
      await options.onDeclineQuestion?.(handle);
    },
    cancelRun: async () => {
      calls.cancelRun += 1;
      await options.onCancelRun?.(handle);
    },
    close: async () => {
      calls.close += 1;
      await options.onClose?.(handle);
    },
    lastResult: () => lastResult,
    takeNavigationRequest: () => {
      calls.takeNavigationRequest += 1;
      const request = navigation;
      navigation = null;
      return request;
    },
    closePanel: () => {
      calls.closePanel += 1;
    },
    confirmInit: async () => {
      calls.confirmInit += 1;
    },
    addMcpServer: async (entry) => {
      calls.addMcpServer.push(entry);
    },
    removeMcpServer: async (serverId) => {
      calls.removeMcpServer.push(serverId);
    },
    renameSession: async (sessionId, title) => {
      calls.renameSession.push({ sessionId, title });
    },
    deleteSession: async (sessionId) => {
      calls.deleteSession.push(sessionId);
    },
    deleteMemory: async (id) => {
      calls.deleteMemory.push(id);
    },
    correctCredential: async (secret) => {
      calls.correctCredential.push(secret);
      return true;
    },
  };

  handle = {
    controller,
    calls,
    setView: (next) => {
      view = next;
    },
    patchView: (patch) => {
      view = { ...view, ...patch };
    },
    currentView: () => view,
    setLastResult: (next) => {
      lastResult = next;
    },
    setNavigation: (request) => {
      navigation = request;
    },
  };
  return handle;
}

export type FakeRuntimeOptions = Readonly<{
  sessionId?: string;
  controller?: TuiController;
  modelLabel?: string | null;
  modeLabel?: WebSessionRuntime["modeLabel"];
  contextWindow?: number | null;
  demo?: boolean;
  warnings?: readonly string[];
}>;

/** A `WebSessionRuntime` with a fake controller and realistic defaults. */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): WebSessionRuntime {
  return {
    sessionId: options.sessionId ?? "session-current",
    controller: options.controller ?? createFakeController().controller,
    modelLabel: options.modelLabel === undefined ? "deepseek-v4.1-flash" : options.modelLabel,
    modeLabel: options.modeLabel ?? "full",
    contextWindow: options.contextWindow === undefined ? 262144 : options.contextWindow,
    demo: options.demo ?? false,
    warnings: options.warnings ?? [],
  };
}

export type FakeOpenerHandle = Readonly<{
  opener: WebSessionOpener;
  /** Every session id passed to the opener, in order. */
  calls: (string | null)[];
  /** The runtimes the opener produced, in order. */
  opened: WebSessionRuntime[];
  /**
   * Make the next open for this id reject. The error may carry a `code` property
   * (`not_found` etc.) the host is expected to propagate.
   */
  failNext: (sessionId: string | null, error: unknown) => void;
}>;

export type FakeOpenerOptions = Readonly<{
  /** Build the runtime for an id; defaults to a fresh fake runtime per call. */
  open?: (sessionId: string | null) => WebSessionRuntime | Promise<WebSessionRuntime>;
}>;

/**
 * A `WebSessionOpener` that records calls and can be made to fail once.
 *
 * `null` (a new Session) gets a unique generated id so a switch-to-new can be
 * observed by session id, exactly like the real bootstrap factory.
 */
export function createFakeOpener(options: FakeOpenerOptions = {}): FakeOpenerHandle {
  const calls: (string | null)[] = [];
  const opened: WebSessionRuntime[] = [];
  const failures = new Map<string, unknown>();
  let nextNewId = 0;

  const opener: WebSessionOpener = async (sessionId) => {
    calls.push(sessionId);
    const failureKey = String(sessionId);
    if (failures.has(failureKey)) {
      const error = failures.get(failureKey);
      failures.delete(failureKey);
      throw error;
    }
    let runtime: WebSessionRuntime;
    if (options.open === undefined) {
      nextNewId += 1;
      runtime = createFakeRuntime({
        sessionId: sessionId ?? `session-new-${nextNewId.toString().padStart(3, "0")}`,
      });
    } else {
      runtime = await options.open(sessionId);
    }
    opened.push(runtime);
    return runtime;
  };

  return {
    opener,
    calls,
    opened,
    failNext: (sessionId, error) => {
      failures.set(String(sessionId), error);
    },
  };
}

export type FakeCatalogEntry = Omit<WebSessionListEntry, "current">;

export type FakeCatalogHandle = Readonly<{
  catalog: WebSessionCatalog;
  /** Mutable backing entries; mutations are visible to the next `list()` call. */
  entries: FakeCatalogEntry[];
  /** Number of times `list()` was invoked. */
  listCalls: number;
  renamed: RenameRecord[];
  removed: string[];
  /** Fail the next operation with this code. */
  failNext: (code: string) => void;
  /** Reset the per-operation call counters without touching the entries. */
  resetCalls: () => void;
}>;

/** A `WebSessionCatalog` over an in-memory list, recording edits. */
export function createFakeCatalog(entries: readonly FakeCatalogEntry[] = []): FakeCatalogHandle {
  const handle = {
    entries: [...entries],
    listCalls: 0,
    renamed: [] as RenameRecord[],
    removed: [] as string[],
  };
  const failures: string[] = [];
  const takeFailure = (): string | null => failures.shift() ?? null;

  const catalog: WebSessionCatalog = {
    list: async () => {
      handle.listCalls += 1;
      const failed = takeFailure();
      if (failed !== null) return { ok: false, code: failed };
      return { ok: true, sessions: handle.entries.map((entry) => ({ ...entry })) };
    },
    rename: async (sessionId, title) => {
      handle.renamed.push({ sessionId, title });
      const failed = takeFailure();
      if (failed !== null) return { ok: false, code: failed };
      const entry = handle.entries.find((candidate) => candidate.sessionId === sessionId);
      if (entry === undefined) return { ok: false as const, code: "not_found" };
      handle.entries = handle.entries.map((candidate) =>
        candidate.sessionId === sessionId ? { ...candidate, title } : candidate,
      );
      return { ok: true as const };
    },
    remove: async (sessionId) => {
      handle.removed.push(sessionId);
      const failed = takeFailure();
      if (failed !== null) return { ok: false, code: failed };
      if (!handle.entries.some((candidate) => candidate.sessionId === sessionId))
        return { ok: false as const, code: "not_found" };
      handle.entries = handle.entries.filter((candidate) => candidate.sessionId !== sessionId);
      return { ok: true as const };
    },
  };

  return {
    get catalog() {
      return catalog;
    },
    get entries() {
      return handle.entries;
    },
    set entries(next) {
      handle.entries = next;
    },
    get listCalls() {
      return handle.listCalls;
    },
    set listCalls(next) {
      handle.listCalls = next;
    },
    get renamed() {
      return handle.renamed;
    },
    get removed() {
      return handle.removed;
    },
    failNext: (code) => {
      failures.push(code);
    },
    resetCalls: () => {
      handle.listCalls = 0;
    },
  };
}

/**
 * A stand-in for `WebSessionHost` in the server integration tests.
 *
 * The server only talks to the host interface, so a deterministic host keeps
 * those tests about routing and protocol rather than about recorded sessions.
 */
export type FakeHostOptions = Readonly<{
  initial: WebSessionRuntime;
  sessions?: readonly FakeCatalogEntry[];
  switching?: boolean;
  /** Replacement runtime for a switch; defaults to a fresh fake runtime. */
  onSwitch?: (sessionId: string | null) => WebSessionRuntime | Promise<WebSessionRuntime>;
}>;

export type FakeHostCalls = {
  switchSession: (string | null)[];
  listSessions: number;
  renameSession: RenameRecord[];
  deleteSession: string[];
  close: number;
};

export type FakeHostHandle = Readonly<{
  host: WebSessionHost;
  calls: FakeHostCalls;
  currentRuntime: () => WebSessionRuntime;
  setCurrent: (runtime: WebSessionRuntime) => void;
  setSessions: (entries: readonly FakeCatalogEntry[]) => void;
  setSwitching: (value: boolean) => void;
  failNextSwitch: (error: unknown) => void;
  failNextRename: (error: unknown) => void;
  failNextDelete: (error: unknown) => void;
}>;

export function createFakeHost(options: FakeHostOptions): FakeHostHandle {
  let runtime = options.initial;
  let switching = options.switching ?? false;
  let sessions: readonly FakeCatalogEntry[] = options.sessions ?? [];
  let newSessionCounter = 0;
  let pendingSwitch: unknown = null;
  let pendingRename: unknown = null;
  let pendingDelete: unknown = null;
  const calls: FakeHostCalls = {
    switchSession: [],
    listSessions: 0,
    renameSession: [],
    deleteSession: [],
    close: 0,
  };

  const host: WebSessionHost = {
    current: () => runtime,
    isSwitching: () => switching,
    listSessions: async () => {
      calls.listSessions += 1;
      const currentId = runtime.sessionId;
      return sessions.map((entry) => ({ ...entry, current: entry.sessionId === currentId }));
    },
    switchSession: async (sessionId) => {
      calls.switchSession.push(sessionId);
      if (pendingSwitch !== null) {
        const error = pendingSwitch;
        pendingSwitch = null;
        throw error;
      }
      if (sessionId !== null && sessionId === runtime.sessionId) return runtime;
      switching = true;
      try {
        runtime =
          options.onSwitch !== undefined
            ? await options.onSwitch(sessionId)
            : createFakeRuntime({ sessionId: sessionId ?? `session-fake-${++newSessionCounter}` });
      } finally {
        switching = false;
      }
      return runtime;
    },
    renameSession: async (sessionId, title) => {
      calls.renameSession.push({ sessionId, title });
      if (pendingRename !== null) {
        const error = pendingRename;
        pendingRename = null;
        throw error;
      }
      sessions = sessions.map((entry) =>
        entry.sessionId === sessionId ? { ...entry, title } : entry,
      );
    },
    deleteSession: async (sessionId) => {
      calls.deleteSession.push(sessionId);
      if (sessionId === runtime.sessionId) {
        throw new WebSessionError("conflict", "the current session cannot be deleted");
      }
      if (pendingDelete !== null) {
        const error = pendingDelete;
        pendingDelete = null;
        throw error;
      }
      sessions = sessions.filter((entry) => entry.sessionId !== sessionId);
    },
    close: async () => {
      calls.close += 1;
    },
  };

  return {
    host,
    calls,
    currentRuntime: () => runtime,
    setCurrent: (next) => {
      runtime = next;
    },
    setSessions: (next) => {
      sessions = [...next];
    },
    setSwitching: (value) => {
      switching = value;
    },
    failNextSwitch: (error) => {
      pendingSwitch = error;
    },
    failNextRename: (error) => {
      pendingRename = error;
    },
    failNextDelete: (error) => {
      pendingDelete = error;
    },
  };
}

/**
 * A stand-in for the static asset directory.
 *
 * The server integration tests supply the handful of files they need and assert
 * what the asset source was asked for; the real filesystem behaviour lives in
 * the unit tests for `createAssetSource`.
 */
export type FakeAssetFile = Readonly<{ body: string | Uint8Array; contentType: string }>;

export type FakeAssetSourceHandle = Readonly<{
  source: WebAssetSource;
  reads: string[];
}>;

export function createFakeAssetSource(
  files: Readonly<Record<string, FakeAssetFile>>,
): FakeAssetSourceHandle {
  const reads: string[] = [];
  const source: WebAssetSource = {
    read: async (pathname) => {
      reads.push(pathname);
      const file = files[pathname];
      if (file === undefined) return null;
      return {
        body: typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body,
        contentType: file.contentType,
      };
    },
  };
  return { source, reads };
}
