import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../../domain/config/jsonc.js";
import { readBoundedUtf8 } from "../persistence/bounded-utf8-file.js";
import { acquireExclusiveFileLease } from "./exclusive-file-lease.js";
/**
 * User settings persistence with a local-user configuration lock and
 * compare-and-swap (V1_BEHAVIOR_CONTRACTS section 9).
 *
 * The contract is specific about failure shape, so the implementation is too:
 *
 * - a save carries `{ baseRevision, baseDocumentHash, draft }`;
 * - inside the lock the file is re-read and strictly validated;
 * - a revision or hash mismatch returns `config_conflict` and keeps the caller's
 *   draft; it never merges and never lets the last writer win;
 * - a lock that cannot be taken within 2s returns `config_busy` and changes
 *   nothing;
 * - replacement goes through a temporary file in the same directory.
 *
 * This lock is separate from the Session writer and the search ledger lock. It
 * does not make file replacement power-loss safe; that is G03/G05 work.
 */
export const CONFIG_LIMITS = Object.freeze({
    lockTimeoutMs: 2_000,
    lockRetryMs: 25,
    maxDocumentBytes: 1024 * 1024,
    schemaVersion: 1,
});
export const SETTINGS_FILENAME = "settings.jsonc";
const LOCK_FILENAME = "settings.lock";
export function defaultConfigDirectory(localAppData) {
    const base = localAppData === undefined || localAppData.length === 0
        ? path.join(process.cwd(), ".lycwl-agent")
        : path.join(localAppData, "lycwl-agent");
    return path.join(base, "config");
}
export function hashDocument(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
export function createConfigStore(options) {
    const filePath = path.join(options.directory, SETTINGS_FILENAME);
    const lockPath = path.join(options.directory, LOCK_FILENAME);
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    async function load() {
        const read = await readBoundedUtf8(filePath, CONFIG_LIMITS.maxDocumentBytes);
        if (read.ok)
            return validateDocument(read.text);
        return {
            ok: false,
            code: read.code === "missing"
                ? "config_missing"
                : read.code === "too_large"
                    ? "config_too_large"
                    : read.code === "invalid_utf8"
                        ? "config_invalid"
                        : "config_unreadable",
        };
    }
    /**
     * Save a draft only when the caller's base matches what is on disk.
     *
     * The draft is the full intended document text, produced by the localized edit
     * helpers, so this layer never re-serializes and never loses comments.
     */
    async function save(input) {
        if (Buffer.byteLength(input.draft, "utf8") > CONFIG_LIMITS.maxDocumentBytes) {
            return { ok: false, code: "config_too_large" };
        }
        const draftValidation = validateDocument(input.draft);
        if (!draftValidation.ok)
            return { ok: false, code: "config_invalid" };
        await mkdir(options.directory, { recursive: true });
        const lock = await acquireLock();
        if (!lock.ok)
            return { ok: false, code: lock.code };
        try {
            // Re-read inside the lock: anything written between the caller's read and
            // now is a conflict, not a stale value to overwrite.
            const current = await load();
            if (!current.ok && current.code !== "config_missing") {
                return { ok: false, code: current.code };
            }
            if (current.ok) {
                if (current.value.revision !== input.baseRevision ||
                    current.value.documentHash !== input.baseDocumentHash) {
                    return {
                        ok: false,
                        code: "config_conflict",
                        draft: input.draft,
                        current: current.value,
                    };
                }
            }
            else if (input.baseRevision !== 0 || input.baseDocumentHash !== "") {
                // The caller expected an existing document that is no longer there.
                return { ok: false, code: "config_conflict", draft: input.draft };
            }
            const nextRevision = (current.ok ? current.value.revision : 0) + 1;
            const text = bumpRevision(input.draft, nextRevision);
            if (text === null) {
                return { ok: false, code: "config_invalid", draft: input.draft };
            }
            const temporary = path.join(options.directory, `${SETTINGS_FILENAME}.${randomUUID()}.tmp`);
            try {
                const handle = await open(temporary, "wx", 0o600);
                try {
                    await handle.writeFile(text, "utf8");
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                await rename(temporary, filePath);
            }
            catch {
                await unlink(temporary).catch(() => undefined);
                return { ok: false, code: "write_failed" };
            }
            const reloaded = validateDocument(text);
            if (!reloaded.ok)
                return { ok: false, code: "config_invalid" };
            return { ok: true, value: reloaded.value };
        }
        finally {
            lock.release();
        }
    }
    async function acquireLock() {
        try {
            const lease = await acquireExclusiveFileLease(lockPath, {
                timeoutMs: CONFIG_LIMITS.lockTimeoutMs,
                now,
                sleep,
            });
            return { ok: true, release: lease.release };
        }
        catch {
            return { ok: false, code: "config_busy" };
        }
    }
    return { load, save, filePath };
}
/** Parse, validate and extract the metadata a save must compare against. */
export function validateDocument(text) {
    if (Buffer.byteLength(text, "utf8") > CONFIG_LIMITS.maxDocumentBytes) {
        return { ok: false, code: "config_too_large" };
    }
    const parsed = parseJsonc(text);
    if (!parsed.ok)
        return { ok: false, code: "config_invalid" };
    if (parsed.value.kind !== "object")
        return { ok: false, code: "config_invalid" };
    const schemaVersion = readInteger(parsed.value, "schemaVersion");
    if (schemaVersion === null)
        return { ok: false, code: "config_invalid" };
    // V1 writes only its own version. An unknown version is not "fields we can
    // ignore": depending on it would mean acting on unverified state.
    if (schemaVersion !== CONFIG_LIMITS.schemaVersion) {
        return { ok: false, code: "unsupported_schema_version" };
    }
    const revision = readInteger(parsed.value, "revision");
    if (revision === null || revision < 0)
        return { ok: false, code: "config_invalid" };
    return {
        ok: true,
        value: { text, documentHash: hashDocument(text), revision, schemaVersion },
    };
}
/**
 * Bump `revision` with a localized edit. Returns null when the draft has no
 * revision field, which would mean the caller produced an invalid document.
 */
function bumpRevision(text, nextRevision) {
    const parsed = parseJsonc(text);
    if (!parsed.ok || parsed.value.kind !== "object")
        return null;
    const member = parsed.value.members.find((entry) => entry.key === "revision");
    if (member === undefined)
        return null;
    return `${text.slice(0, member.value.start)}${nextRevision}${text.slice(member.value.end)}`;
}
function readInteger(node, key) {
    const member = node.members.find((entry) => entry.key === key);
    if (member === undefined)
        return null;
    if (member.value.kind !== "number")
        return null;
    const value = member.value.value;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
