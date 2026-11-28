import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { MEMORY_LIMITS, parseMemoryFile, purgeExpiredMemory, resolveMemoryId, serializeMemoryFile, validateMemoryContent, validateMemoryTimestamp, } from "../../domain/memory/memory.js";
import { acquireExclusiveFileLease } from "../platform-file-lease.js";
import { readBoundedUtf8 } from "./bounded-utf8-file.js";
export const MEMORY_FILENAME = "memory.json";
const LOCK_FILENAME = "memory.lock";
export function createMemoryStore(options) {
    const filePath = path.join(options.directory, MEMORY_FILENAME);
    const lockPath = path.join(options.directory, LOCK_FILENAME);
    const nowUtc = options.nowUtc ?? (() => new Date().toISOString());
    async function load() {
        const read = await readBoundedUtf8(filePath, MEMORY_LIMITS.maxFileBytes);
        if (!read.ok) {
            if (read.code === "missing")
                return { ok: true, entries: [] };
            return { ok: false, code: "invalid_file" };
        }
        return parseMemoryFile(read.text);
    }
    async function write(entries) {
        await mkdir(options.directory, {
            recursive: true,
            ...(process.platform === "linux" ? { mode: 0o700 } : {}),
        });
        const lease = await acquireExclusiveFileLease(lockPath).catch(() => null);
        if (lease === null)
            return "write_failed";
        const temporary = path.join(options.directory, `${MEMORY_FILENAME}.${randomUUID()}.tmp`);
        try {
            const handle = await open(temporary, "wx", process.platform === "linux" ? 0o600 : undefined);
            try {
                await handle.writeFile(serializeMemoryFile(entries), "utf8");
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await rename(temporary, filePath);
            return null;
        }
        catch {
            await unlink(temporary).catch(() => undefined);
            return "write_failed";
        }
        finally {
            lease.release();
        }
    }
    async function withEntries(operation) {
        const loaded = await load();
        if (!loaded.ok)
            return loaded;
        const result = await operation(loaded.entries);
        if (!result.ok)
            return { ok: false, code: result.code };
        return { ok: true, value: result.value };
    }
    return {
        load,
        async add(input) {
            const content = validateMemoryContent(input.content);
            if (!content.ok)
                return content;
            if (input.expiresAtUtc !== undefined && input.expiresAtUtc !== null) {
                const expires = validateMemoryTimestamp(input.expiresAtUtc);
                if (!expires.ok)
                    return expires;
            }
            if (input.type === "user") {
                if (input.scope === "global" && input.projectRoot !== null) {
                    return { ok: false, code: "project_required" };
                }
            }
            else if (input.scope !== "project") {
                return { ok: false, code: "global_requires_user" };
            }
            if (input.scope === "project" &&
                (input.projectRoot === null || input.projectRoot.length === 0)) {
                return { ok: false, code: "project_required" };
            }
            if (input.scope === "global" && input.type !== "user") {
                return { ok: false, code: "global_requires_user" };
            }
            const result = await withEntries(async (entries) => {
                const active = purgeExpiredMemory(entries, nowUtc());
                const duplicate = active.find((entry) => entry.type === input.type &&
                    entry.scope === input.scope &&
                    entry.projectRoot === input.projectRoot &&
                    entry.content.toLowerCase() === content.content.toLowerCase());
                if (duplicate !== undefined)
                    return { ok: true, value: duplicate };
                if (active.length >= MEMORY_LIMITS.maxEntries) {
                    return { ok: false, code: "too_many_entries" };
                }
                const now = nowUtc();
                const entry = {
                    id: randomUUID(),
                    type: input.type,
                    scope: input.scope,
                    projectRoot: input.projectRoot,
                    content: content.content,
                    source: "user_explicit",
                    createdAtUtc: now,
                    updatedAtUtc: now,
                    expiresAtUtc: input.expiresAtUtc ?? null,
                };
                const failure = await write([...active, entry]);
                return failure === null
                    ? { ok: true, value: entry }
                    : { ok: false, code: failure };
            });
            return result.ok ? { ok: true, entry: result.value } : result;
        },
        async replace(id, input) {
            const content = validateMemoryContent(input.content);
            if (!content.ok)
                return content;
            if (input.expiresAtUtc !== undefined && input.expiresAtUtc !== null) {
                const expires = validateMemoryTimestamp(input.expiresAtUtc);
                if (!expires.ok)
                    return expires;
            }
            const result = await withEntries(async (entries) => {
                const resolved = resolveMemoryId(entries, id);
                if (!resolved.ok)
                    return { ok: false, code: resolved.code };
                const updated = {
                    ...resolved.entry,
                    content: content.content,
                    updatedAtUtc: nowUtc(),
                    expiresAtUtc: input.expiresAtUtc === undefined ? resolved.entry.expiresAtUtc : input.expiresAtUtc,
                };
                const next = purgeExpiredMemory(entries, nowUtc()).map((entry) => entry.id === updated.id ? updated : entry);
                const failure = await write(next);
                return failure === null
                    ? { ok: true, value: updated }
                    : { ok: false, code: failure };
            });
            return result.ok ? { ok: true, entry: result.value } : result;
        },
        async remove(id) {
            const result = await withEntries(async (entries) => {
                const resolved = resolveMemoryId(entries, id);
                if (!resolved.ok)
                    return { ok: false, code: resolved.code };
                const next = purgeExpiredMemory(entries, nowUtc()).filter((entry) => entry.id !== resolved.entry.id);
                const failure = await write(next);
                return failure === null
                    ? { ok: true, value: resolved.entry }
                    : { ok: false, code: failure };
            });
            return result.ok ? { ok: true, entry: result.value } : result;
        },
    };
}
