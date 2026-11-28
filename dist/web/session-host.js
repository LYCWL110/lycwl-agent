/** Session list reads are cheap but not free; the sidebar samples them on every tick. */
const CATALOG_CACHE_MS = 1000;
/**
 * A session operation the server can translate into an HTTP failure.
 *
 * The code is a `WebErrorCode` because the web layer must not invent its own
 * vocabulary at the boundary: the client already switches on these values.
 */
export class WebSessionError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.name = "WebSessionError";
        this.code = code;
    }
}
export function createWebSessionHost(options) {
    const log = options.log ?? (() => undefined);
    const now = options.now ?? (() => Date.now());
    let runtime = options.initial;
    let switching = false;
    let closed = false;
    let closing = null;
    let cached = null;
    let inFlight = null;
    /** Invalidates a catalog read that was already in flight when a change landed. */
    let generation = 0;
    /** Switches run one at a time; a failed switch must not block the next one. */
    let tail = Promise.resolve();
    function current() {
        return runtime;
    }
    function isSwitching() {
        return switching;
    }
    function markCurrent(entries) {
        const sessionId = runtime.sessionId;
        return entries.map((entry) => ({ ...entry, current: entry.sessionId === sessionId }));
    }
    function enqueue(task) {
        const result = tail.then(task, task);
        tail = result.then(() => undefined, () => undefined);
        return result;
    }
    async function loadSessions() {
        const token = generation;
        try {
            const listed = await options.catalog.list();
            if (token !== generation)
                return listed.ok ? listed.sessions : [];
            if (listed.ok) {
                cached = { at: now(), entries: listed.sessions };
                return listed.sessions;
            }
            log(`session catalog failed: ${listed.code}`);
        }
        catch (error) {
            log(`session catalog failed: ${describeError(error)}`);
        }
        if (token !== generation)
            return [];
        const fallback = cached?.entries ?? [];
        // Cache the failure briefly as well: the SSE tick would otherwise retry an
        // unreadable directory several times a second.
        cached = { at: now(), entries: fallback };
        return fallback;
    }
    function listSessions() {
        const currentCache = cached;
        if (currentCache !== null && now() - currentCache.at < CATALOG_CACHE_MS) {
            return Promise.resolve(markCurrent(currentCache.entries));
        }
        if (inFlight !== null)
            return inFlight.then(markCurrent);
        const pending = loadSessions();
        inFlight = pending;
        void pending.then(() => {
            if (inFlight === pending)
                inFlight = null;
        }, () => {
            if (inFlight === pending)
                inFlight = null;
        });
        return pending.then(markCurrent);
    }
    /** Drop the cached list and re-read it after a rename or delete. */
    async function refreshSessions() {
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
        }
        catch (error) {
            log(`session catalog refresh failed: ${describeError(error)}`);
        }
    }
    function openFailure(error) {
        if (error instanceof WebSessionError)
            return error;
        const message = error instanceof Error ? error.message : String(error);
        if (errorCode(error) === "not_found")
            return new WebSessionError("not_found", message);
        return new WebSessionError("session_open_failed", message);
    }
    function catalogFailure(code, action) {
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
    function switchSession(sessionId) {
        if (closed) {
            return Promise.reject(new WebSessionError("unavailable", "the web session host is closed"));
        }
        if (!switching && sessionId !== null && sessionId === runtime.sessionId) {
            return Promise.resolve(runtime);
        }
        return enqueue(async () => {
            if (closed)
                throw new WebSessionError("unavailable", "the web session host is closed");
            // The id may have become current while this request waited in the queue.
            if (sessionId !== null && sessionId === runtime.sessionId)
                return runtime;
            switching = true;
            try {
                let opened;
                try {
                    opened = await options.openSession(sessionId);
                }
                catch (error) {
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
                }
                catch (error) {
                    // The replacement runtime is already live; a failed close must not undo
                    // the switch, so it is reported and the new session stays usable.
                    log(`previous session close failed: ${describeError(error)}`);
                }
                return runtime;
            }
            finally {
                switching = false;
            }
        });
    }
    function reloadCurrent() {
        return enqueue(async () => {
            if (closed)
                throw new WebSessionError("unavailable", "the web session host is closed");
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
            }
            catch (error) {
                throw openFailure(error);
            }
            finally {
                switching = false;
            }
        });
    }
    async function renameSession(sessionId, title) {
        let renamed;
        try {
            renamed = await options.catalog.rename(sessionId, title);
        }
        catch (error) {
            throw new WebSessionError("catalog_failed", `session rename failed: ${describeError(error)}`);
        }
        if (!renamed.ok)
            throw catalogFailure(renamed.code, "rename");
        await refreshSessions();
    }
    async function deleteSession(sessionId) {
        if (sessionId === runtime.sessionId) {
            throw new WebSessionError("conflict", "the current session cannot be deleted");
        }
        let removed;
        try {
            removed = await options.catalog.remove(sessionId);
        }
        catch (error) {
            throw new WebSessionError("catalog_failed", `session delete failed: ${describeError(error)}`);
        }
        if (!removed.ok)
            throw catalogFailure(removed.code, "delete");
        await refreshSessions();
    }
    function close() {
        if (closing !== null)
            return closing;
        closed = true;
        closing = (async () => {
            // Let an in-flight switch finish so the runtime we close is the final one.
            await tail;
            try {
                await runtime.controller.close();
            }
            catch (error) {
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
function errorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return null;
    const code = error.code;
    return typeof code === "string" ? code : null;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
