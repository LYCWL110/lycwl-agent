import { open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSessionId } from "../../domain/identity/session-id.js";
import { assertSessionId, compareSessionsNewestFirst, firstInputFromHead, lastActivityFromTail, readSidecarTitle, SESSION_TITLE_LIMITS, serializeSidecar, validateSessionTitle, } from "../../domain/session/session-catalog.js";
import { acquireExclusiveFileLease } from "./exclusive-file-lease.js";
const SESSIONS_ROOT = path.join("sessions", "sessions");
const EVENTS_FILENAME = "events.jsonl";
const SIDECAR_FILENAME = "session.json";
const LOCK_FILENAME = "session.lock";
export function createSessionCatalog(options) {
    const nowUtc = options.nowUtc ?? (() => new Date().toISOString());
    const root = path.join(options.dataDirectory, SESSIONS_ROOT);
    async function list() {
        let entries;
        try {
            entries = await readdir(root);
        }
        catch (error) {
            // No sessions yet is an empty catalog, not a failure.
            if (isNotFound(error))
                return { ok: true, sessions: [] };
            return { ok: false, code: "not_a_session" };
        }
        const sessions = [];
        for (const entry of entries) {
            if (!isSessionId(entry))
                continue;
            const summary = await readSummary(entry);
            if (summary !== null)
                sessions.push(summary);
        }
        // Newest first, by recorded activity rather than by file timestamp.
        sessions.sort(compareSessionsNewestFirst);
        return { ok: true, sessions };
    }
    async function readSummary(sessionId) {
        const directory = path.join(root, sessionId);
        const eventsPath = path.join(directory, EVENTS_FILENAME);
        let info;
        try {
            info = await stat(eventsPath);
        }
        catch {
            return null;
        }
        // A symlink could point anywhere; a session log is an ordinary file.
        if (!info.isFile() || info.size === 0)
            return null;
        const title = await readTitle(directory);
        const firstInput = await readFirstInput(eventsPath);
        const activity = await readLastActivity(eventsPath, info.size);
        return {
            sessionId,
            title,
            firstInput,
            bytes: info.size,
            // The mtime is a fallback, not the source: a copied data directory rewrites
            // it and every session would then claim to have been used at copy time.
            modifiedAtUtc: activity ?? info.mtime.toISOString(),
        };
    }
    async function readTitle(directory) {
        try {
            const info = await stat(path.join(directory, SIDECAR_FILENAME));
            if (!info.isFile() || info.size > SESSION_TITLE_LIMITS.maxSidecarBytes)
                return null;
            return readSidecarTitle(await readFile(path.join(directory, SIDECAR_FILENAME), "utf8"));
        }
        catch {
            return null;
        }
    }
    /**
     * Read the tail of the log to find the newest recorded timestamp.
     *
     * Only the tail is read, for the same reason only the head is read: a long
     * session's log can be many megabytes. The window grows once if the first
     * attempt finds no complete record, which happens when a single event is larger
     * than the window.
     */
    async function readLastActivity(eventsPath, size) {
        let handle = null;
        try {
            handle = await open(eventsPath, "r");
            for (const window of [
                SESSION_TITLE_LIMITS.maxTailBytes,
                SESSION_TITLE_LIMITS.maxTailBytes * 8,
            ]) {
                const length = Math.min(window, size);
                if (length === 0)
                    return null;
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, size - length);
                const activity = lastActivityFromTail(buffer.subarray(0, bytesRead).toString("utf8"));
                if (activity !== null)
                    return activity;
            }
            return null;
        }
        catch {
            return null;
        }
        finally {
            await handle?.close();
        }
    }
    /**
     * Read only the head of the log.
     *
     * A long session's log can be many megabytes, and the first task is always near
     * the start. Reading the whole file to display one row would make listing slow
     * for exactly the sessions a user has used most.
     */
    async function readFirstInput(eventsPath) {
        let handle = null;
        try {
            handle = await open(eventsPath, "r");
            const buffer = Buffer.alloc(SESSION_TITLE_LIMITS.maxHeadBytes);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return firstInputFromHead(buffer.subarray(0, bytesRead).toString("utf8"));
        }
        catch {
            return null;
        }
        finally {
            await handle?.close();
        }
    }
    async function rename(sessionId, title) {
        try {
            assertSessionId(sessionId);
        }
        catch {
            return { ok: false, code: "invalid_session_id" };
        }
        const directory = path.join(root, sessionId);
        if (!(await hasLog(directory)))
            return { ok: false, code: "session_not_found" };
        // Clearing a title restores the derived label, which is why null is allowed and
        // writes a sidecar with no title rather than deleting it: an explicit "no title"
        // and "never renamed" are the same display, so either write is honest.
        if (title === null) {
            try {
                await writeFile(path.join(directory, SIDECAR_FILENAME), serializeSidecar("", nowUtc()), "utf8");
                return { ok: true };
            }
            catch {
                return { ok: false, code: "write_failed" };
            }
        }
        const validated = validateSessionTitle(title);
        if (!validated.ok)
            return { ok: false, code: "invalid_title" };
        try {
            await writeFile(path.join(directory, SIDECAR_FILENAME), serializeSidecar(validated.title, nowUtc()), "utf8");
            return { ok: true };
        }
        catch {
            return { ok: false, code: "write_failed" };
        }
    }
    async function remove(sessionId) {
        try {
            assertSessionId(sessionId);
        }
        catch {
            return { ok: false, code: "invalid_session_id" };
        }
        const directory = path.join(root, sessionId);
        if (!(await hasLog(directory)))
            return { ok: false, code: "session_not_found" };
        // Probe ownership before deleting. A live runtime holds this lease for the whole
        // Session, so failing here means "in use" rather than "deleted halfway".
        //
        // The lease is released before the delete because Windows refuses to remove a
        // directory containing an open handle. That leaves a window between the release
        // and the delete; it is accepted because the alternative — holding the lock
        // through the delete — cannot work at all, and a runtime that acquires the
        // session in that window will fail to append to a log that is being removed
        // rather than silently interleaving writes.
        try {
            const lease = await acquireExclusiveFileLease(path.join(directory, LOCK_FILENAME), {
                timeoutMs: 0,
            });
            lease.release();
        }
        catch {
            return { ok: false, code: "session_in_use" };
        }
        try {
            await rm(directory, { recursive: true, force: false });
            return { ok: true };
        }
        catch {
            return { ok: false, code: "delete_failed" };
        }
    }
    async function hasLog(directory) {
        try {
            const info = await stat(path.join(directory, EVENTS_FILENAME));
            return info.isFile() && info.size > 0;
        }
        catch {
            return false;
        }
    }
    return { list, rename, remove };
}
function isNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
