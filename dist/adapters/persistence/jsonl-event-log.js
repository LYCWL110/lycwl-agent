import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../../domain/config/jsonc.js";
import { isSessionId } from "../../domain/identity/session-id.js";
import { acquireExclusiveFileLease, } from "../windows/exclusive-file-lease.js";
import { applyEventToRelations, createRelationState, hasValidInternalEventRelations, } from "./internal-event-relations.js";
import { isInternalEvent } from "./internal-event-validation.js";
export class JsonlEventLog {
    #root;
    #ids;
    #digests;
    #writeTails = new Map();
    /** Verified prefix per session, so an append does not replay the whole log. */
    #verified = new Map();
    constructor(root, ids, digests) {
        this.#root = root;
        this.#ids = ids;
        this.#digests = digests;
    }
    append(input) {
        const previousTail = this.#writeTails.get(input.sessionId) ?? Promise.resolve();
        const operation = previousTail.then(() => this.#appendNow(input));
        this.#writeTails.set(input.sessionId, operation.then(() => undefined, () => undefined));
        return operation;
    }
    async read(sessionId) {
        await (this.#writeTails.get(sessionId) ?? Promise.resolve());
        const result = await this.readWithRecovery(sessionId);
        if (!result.ok)
            throw new Error(result.code);
        return result.events;
    }
    async readWithRecovery(sessionId) {
        const filePath = this.#eventPath(sessionId);
        let bytes;
        try {
            bytes = await readFile(filePath);
        }
        catch (error) {
            if (isNotFound(error))
                return { ok: true, events: [] };
            throw error;
        }
        if (bytes.length === 0)
            return { ok: true, events: [] };
        const endsWithNewline = bytes.at(-1) === 0x0a;
        let text;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            return { ok: false, code: "invalid_event" };
        }
        const lines = text.split("\n");
        if (endsWithNewline)
            lines.pop();
        const events = [];
        const eventIds = new Set();
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            try {
                const value = JSON.parse(line);
                // JSON.parse alone silently accepts duplicate keys.
                if (!parseJsonc(line).ok)
                    return { ok: false, code: "invalid_event" };
                if (!isInternalEvent(value))
                    return { ok: false, code: "invalid_event" };
                const previous = events.at(-1);
                if (value.sessionId !== sessionId ||
                    value.seq !== (previous?.seq ?? 0) + 1 ||
                    value.previousEventId !== (previous?.eventId ?? null) ||
                    value.previousHash !== (previous?.hash ?? null) ||
                    eventIds.has(value.eventId))
                    return { ok: false, code: "integrity_failure" };
                const { hash, ...body } = value;
                if ((await this.#digests.sha256Canonical(body)) !== hash)
                    return { ok: false, code: "integrity_failure" };
                events.push(value);
                eventIds.add(value.eventId);
            }
            catch {
                const isTail = index === lines.length - 1 && !endsWithNewline;
                return { ok: false, code: isTail ? "invalid_event" : "middle_corruption" };
            }
        }
        if (!endsWithNewline)
            return { ok: false, code: "invalid_event" };
        if (!hasValidInternalEventRelations(events))
            return { ok: false, code: "invalid_event" };
        return { ok: true, events };
    }
    async acquireSessionOwnership(sessionId) {
        return acquireExclusiveFileLease(path.join(path.dirname(this.#eventPath(sessionId)), "session.lock"), {
            timeoutMs: 0,
        });
    }
    async #appendNow(input) {
        const lock = await acquireExclusiveFileLease(path.join(path.dirname(this.#eventPath(input.sessionId)), "writer.lock"));
        try {
            return await this.#appendLocked(input);
        }
        finally {
            lock.release();
        }
    }
    async #appendLocked(input) {
        // Continue from the cached verified prefix instead of re-reading the file.
        //
        // Re-reading was quadratic: every append decoded and re-hashed every earlier
        // event. At 2,000 events that made a single append cost 35 ms and the whole
        // log take 46 s to build. The cache is used only when the file still matches
        // the size and tail the cache was built from, so an external edit forces a full
        // re-verification rather than being silently accepted.
        const cached = await this.#verifiedState(input.sessionId);
        const previous = cached.previous;
        const body = {
            schemaVersion: 1,
            eventId: this.#ids.create(),
            sessionId: input.sessionId,
            runId: input.runId,
            seq: (previous?.seq ?? 0) + 1,
            timestampUtc: input.timestampUtc,
            type: input.type,
            correlationId: input.correlationId,
            causationId: input.causationId,
            previousEventId: previous?.eventId ?? null,
            previousHash: previous?.hash ?? null,
            payload: input.payload,
        };
        const event = {
            ...body,
            hash: await this.#digests.sha256Canonical(body),
        };
        if (!isInternalEvent(event))
            throw new Error("invalid_event");
        // Relations are checked against the cached state, which already covers every
        // earlier event. Rebuilding that state was the other half of the cost.
        if (!applyEventToRelations(cached.relations, event))
            throw new Error("invalid_event");
        const filePath = this.#eventPath(input.sessionId);
        await mkdir(path.dirname(filePath), { recursive: true });
        const handle = await open(filePath, "a");
        try {
            await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        // The write succeeded, so the cache now describes this file.
        const writtenBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
        let writtenModifiedMs = cached.modifiedMs;
        try {
            writtenModifiedMs = (await stat(filePath)).mtimeMs;
        }
        catch {
            // If the stat fails the cache is simply not reusable; the next append
            // re-verifies, which is safe.
            writtenModifiedMs = Number.NaN;
        }
        this.#verified.set(input.sessionId, {
            byteLength: cached.byteLength + writtenBytes,
            modifiedMs: writtenModifiedMs,
            previous: event,
            relations: cached.relations,
        });
        return event;
    }
    /**
     * The verified prefix for a session.
     *
     * A cache entry is reused only when the file's size, modification time and last
     * event id all match it. Size alone is not enough: an in-place rewrite that keeps
     * the byte length would pass. The mtime is cheap but coarse on some filesystems,
     * so the tail id is the authoritative check and the mtime only avoids reading
     * when nothing could have changed.
     *
     * Any mismatch discards the entry and re-verifies the whole file, which is the
     * pre-existing behaviour.
     */
    async #verifiedState(sessionId) {
        const cached = this.#verified.get(sessionId);
        const filePath = this.#eventPath(sessionId);
        let info = null;
        try {
            info = await stat(filePath);
        }
        catch (error) {
            if (!isNotFound(error))
                throw error;
            info = null;
        }
        const size = info?.size ?? 0;
        const modifiedMs = info?.mtimeMs ?? 0;
        if (cached !== undefined &&
            cached.byteLength === size &&
            cached.modifiedMs === modifiedMs &&
            (await this.#tailMatches(filePath, cached.previous))) {
            return cached;
        }
        const existing = await this.readWithRecovery(sessionId);
        if (!existing.ok)
            throw new Error(existing.code);
        const relations = createRelationState();
        for (const event of existing.events) {
            if (!applyEventToRelations(relations, event))
                throw new Error("invalid_event");
        }
        const state = {
            byteLength: size,
            modifiedMs,
            previous: existing.events.at(-1) ?? null,
            relations,
        };
        this.#verified.set(sessionId, state);
        return state;
    }
    /**
     * Whether the last complete line of the file still records `expected`.
     *
     * This reads only the tail, so it is cheap regardless of log size. It is what
     * catches an in-place rewrite that preserves the byte length: the size and mtime
     * can agree while the content has changed.
     */
    async #tailMatches(filePath, expected) {
        if (expected === null)
            return false;
        let handle = null;
        try {
            handle = await open(filePath, "r");
            const info = await handle.stat();
            const window = Math.min(info.size, 4_096);
            if (window === 0)
                return false;
            const buffer = Buffer.alloc(window);
            await handle.read(buffer, 0, window, info.size - window);
            const text = buffer.toString("utf8");
            const lines = text.split("\n").filter((line) => line.trim().length > 0);
            const last = lines.at(-1);
            if (last === undefined)
                return false;
            // A tail window may start mid-record, so only the final line is parsed.
            const parsed = JSON.parse(last);
            if (typeof parsed !== "object" || parsed === null)
                return false;
            return parsed["eventId"] === expected.eventId;
        }
        catch {
            return false;
        }
        finally {
            await handle?.close();
        }
    }
    #eventPath(sessionId) {
        if (!isSessionId(sessionId))
            throw new Error("invalid_session_id");
        return path.join(this.#root, "sessions", sessionId, "events.jsonl");
    }
}
function isNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
