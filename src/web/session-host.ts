/**
 * Live Session ownership for the web server.
 *
 * The browser can switch which Session it is looking at, but the process keeps
 * exactly one live runtime at a time (same as the terminal). This host owns that
 * slot: it serializes switches, opens the replacement before closing the current
 * runtime, and exposes the recorded-session catalog for the sidebar.
 *
 * The failure modes are named rather than inferred by the server: `not_found`
 * means that id is not recorded, `session_open_failed` means the runtime could not
 * be built, `conflict` means the request contradicts the live session, and
 * `catalog_failed` means the session directory could not be read or written.
 */
import type {
  WebErrorCode,
  WebSessionCatalog,
  WebSessionListEntry,
  WebSessionOpener,
  WebSessionRuntime,
} from "./protocol.ts";

/** Session list reads are cheap but not free; the sidebar samples them on every tick. */
const CATALOG_CACHE_MS = 1000;

type RawSessionListEntry = Omit<WebSessionListEntry, "current">;

export type WebSessionHostOptions = Readonly<{
  initial: WebSessionRuntime;
  openSession: WebSessionOpener;
  catalog: WebSessionCatalog;
  log?: (message: string) => void;
  /** Clock injection so tests can age the catalog cache without sleeping. */
  now?: () => number;
}>;

export type WebSessionHost = Readonly<{
  current(): WebSessionRuntime;
  isSwitching(): boolean;
  listSessions(): Promise<readonly WebSessionListEntry[]>;
  switchSession(sessionId: string | null): Promise<WebSessionRuntime>;
  reloadCurrent?: () => Promise<WebSessionRuntime>;
  renameSession(sessionId: string, title: string | null): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}>;

/**
 * A session operation the server can translate into an HTTP failure.
 *
 * The code is a `WebErrorCode` because the web layer must not invent its own
 * vocabulary at the boundary: the client already switches on these values.
 */
export class WebSessionError extends Error {
  readonly code: WebErrorCode;

  constructor(code: WebErrorCode, message: string = code) {
    super(message);
    this.name = "WebSessionError";
    this.code = code;
  }
}

export function createWebSessionHost(options: WebSessionHostOptions): WebSessionHost {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  let runtime = options.initial;
  let switching = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  let cached: Readonly<{ at: number; entries: readonly RawSessionListEntry[] }> | null = null;
  let inFlight: Promise<readonly RawSessionListEntry[]> | null = null;
  /** Invalidates a catalog read that was already in flight when a change landed. */
  let generation = 0;
  /** Switches run one at a time; a failed switch must not block the next one. */
  let tail: Promise<unknown> = Promise.resolve();

  function current(): WebSessionRuntime {
    return runtime;
  }

  function isSwitching(): boolean {
    return switching;
  }

  function markCurrent(entries: readonly RawSessionListEntry[]): readonly WebSessionListEntry[] {
    const sessionId = runtime.sessionId;
    return entries.map((entry) => ({ ...entry, current: entry.sessionId === sessionId }));
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function loadSessions(): Promise<readonly RawSessionListEntry[]> {
    const token = generation;
    try {
      const listed = await options.catalog.list();
      if (token !== generation) return listed.ok ? listed.sessions : [];
      if (listed.ok) {
        cached = { at: now(), entries: listed.sessions };
        return listed.sessions;
      }
      log(`session catalog failed: ${listed.code}`);
    } catch (error) {
      log(`session catalog failed: ${describeError(error)}`);
    }
    if (token !== generation) return [];
    const fallback = cached?.entries ?? [];
    // Cache the failure briefly as well: the SSE tick would otherwise retry an
    // unreadable directory several times a second.
    cached = { at: now(), entries: fallback };
    return fallback;
  }

  function listSessions(): Promise<readonly WebSessionListEntry[]> {
    const currentCache = cached;
    if (currentCache !== null && now() - currentCache.at < CATALOG_CACHE_MS) {
      return Promise.resolve(markCurrent(currentCache.entries));
    }
    if (inFlight !== null) return inFlight.then(markCurrent);
    const pending = loadSessions();
    inFlight = pending;
    void pending.then(
      () => {
        if (inFlight === pending) inFlight = null;
      },
      () => {
        if (inFlight === pending) inFlight = null;
      },
    );
    return pending.then(markCurrent);
  }

  /** Drop the cached list and re-read it after a rename or delete. */
  async function refreshSessions(): Promise<void> {
    generation += 1;
    cached = null;
    inFlight = null;
    try {
      const listed = await options.catalog.list();
      if (listed.ok) {
        cached = { at: now(), entries: listed.sessions };
        return;
      }
      log(`session catalog refresh failed: ${listed.code}`);
    } catch (error) {
      log(`session catalog refresh failed: ${describeError(error)}`);
    }
  }

  function openFailure(error: unknown): WebSessionError {
    if (error instanceof WebSessionError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (errorCode(error) === "not_found") return new WebSessionError("not_found", message);
    return new WebSessionError("session_open_failed", message);
  }

  function catalogFailure(code: string, action: string): WebSessionError {
    if (code === "not_found") {
      return new WebSessionError("not_found", `session ${action} failed: ${code}`);
    }
    if (code === "conflict" || code === "session_busy" || code === "busy") {
      return new WebSessionError("conflict", `session ${action} failed: ${code}`);
    }
    if (code === "unavailable") {
      return new WebSessionError("unavailable", `session ${action} failed: ${code}`);
    }
    return new WebSessionError("catalog_failed", `session ${action} failed: ${code}`);
  }

  function switchSession(sessionId: string | null): Promise<WebSessionRuntime> {
    if (closed) {
      return Promise.reject(new WebSessionError("unavailable", "the web session host is closed"));
    }
    if (!switching && sessionId !== null && sessionId === runtime.sessionId) {
      return Promise.resolve(runtime);
    }
    return enqueue(async () => {
      if (closed) throw new WebSessionError("unavailable", "the web session host is closed");
      // The id may have become current while this request waited in the queue.
      if (sessionId !== null && sessionId === runtime.sessionId) return runtime;
      switching = true;
      try {
        let opened: WebSessionRuntime;
        try {
          opened = await options.openSession(sessionId);
        } catch (error) {
          throw openFailure(error);
        }
        const previous = runtime;
        runtime = opened;
        // The sidebar marks `current` by id on read, but a new session may not be
        // in the cached page yet; dropping it makes the row appear on the next read.
        cached = null;
        generation += 1;
        try {
          await previous.controller.close();
        } catch (error) {
          // The replacement runtime is already live; a failed close must not undo
          // the switch, so it is reported and the new session stays usable.
          log(`previous session close failed: ${describeError(error)}`);
        }
        return runtime;
      } finally {
        switching = false;
      }
    });
  }

  function reloadCurrent(): Promise<WebSessionRuntime> {
    return enqueue(async () => {
      if (closed) throw new WebSessionError("unavailable", "the web session host is closed");
      switching = true;
      try {
        const opened = await options.openSession(runtime.sessionId);
        const previous = runtime;
        runtime = opened;
        cached = null;
        generation += 1;
        await previous.controller
          .close()
          .catch((error) => log(`previous session close failed: ${describeError(error)}`));
        return runtime;
      } catch (error) {
        throw openFailure(error);
      } finally {
        switching = false;
      }
    });
  }

  async function renameSession(sessionId: string, title: string | null): Promise<void> {
    let renamed: Awaited<ReturnType<WebSessionCatalog["rename"]>>;
    try {
      renamed = await options.catalog.rename(sessionId, title);
    } catch (error) {
      throw new WebSessionError("catalog_failed", `session rename failed: ${describeError(error)}`);
    }
    if (!renamed.ok) throw catalogFailure(renamed.code, "rename");
    await refreshSessions();
  }

  async function deleteSession(sessionId: string): Promise<void> {
    if (sessionId === runtime.sessionId) {
      throw new WebSessionError("conflict", "the current session cannot be deleted");
    }
    let removed: Awaited<ReturnType<WebSessionCatalog["remove"]>>;
    try {
      removed = await options.catalog.remove(sessionId);
    } catch (error) {
      throw new WebSessionError("catalog_failed", `session delete failed: ${describeError(error)}`);
    }
    if (!removed.ok) throw catalogFailure(removed.code, "delete");
    await refreshSessions();
  }

  function close(): Promise<void> {
    if (closing !== null) return closing;
    closed = true;
    closing = (async () => {
      // Let an in-flight switch finish so the runtime we close is the final one.
      await tail;
      try {
        await runtime.controller.close();
      } catch (error) {
        log(`session close failed: ${describeError(error)}`);
      }
    })();
    return closing;
  }

  return {
    current,
    isSwitching,
    listSessions,
    switchSession,
    reloadCurrent,
    renameSession,
    deleteSession,
    close,
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
