import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canReserve, isChargeUncertain, utcMonthOf, validateTransition, } from "../../domain/web/search-ledger.js";
import { linuxDirectories } from "../linux/directories.js";
export function defaultSearchLedgerDirectory() {
    if (process.platform === "linux")
        return path.join(linuxDirectories().state, "search-usage");
    const localAppData = process.env["LOCALAPPDATA"];
    const base = localAppData === undefined || localAppData.length === 0
        ? path.join(process.cwd(), ".lycwl-agent")
        : path.join(localAppData, "lycwl-agent");
    return path.join(base, "search-usage");
}
export function createSearchLedger(options = {}) {
    const directory = options.directory ?? defaultSearchLedgerDirectory();
    let writeTail = Promise.resolve();
    function ledgerPath() {
        return path.join(directory, "search-ledger.jsonl");
    }
    function lockPath() {
        return path.join(directory, "search-ledger.lock");
    }
    async function readAll() {
        let raw;
        try {
            raw = await readFile(ledgerPath(), "utf8");
        }
        catch (error) {
            if (isNotFound(error))
                return { ok: true, value: [] };
            return { ok: false, code: "ledger_unreadable" };
        }
        const entries = [];
        for (const line of raw.split("\n")) {
            if (line.length === 0)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                // A corrupt line disables search: the quota can no longer be trusted.
                return { ok: false, code: "ledger_corrupt" };
            }
            if (!isLedgerEntry(parsed))
                return { ok: false, code: "ledger_corrupt" };
            entries.push(parsed);
        }
        return { ok: true, value: entries };
    }
    /** Serialize writers within this process and guard against another instance. */
    async function withWriteLock(operation) {
        const previous = writeTail;
        let release = () => undefined;
        writeTail = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        let lockHandle = null;
        try {
            await mkdir(directory, { recursive: true });
            const { open } = await import("node:fs/promises");
            // `wx` fails if another instance holds the lock; that is a fail-closed
            // condition, not a reason to proceed unlocked.
            lockHandle = await open(lockPath(), "wx");
            return await operation();
        }
        catch (error) {
            if (isLockHeld(error)) {
                throw Object.assign(new Error("ledger_locked"), { code: "ledger_locked" });
            }
            throw error;
        }
        finally {
            if (lockHandle !== null) {
                await lockHandle.close().catch(() => undefined);
                const { rm } = await import("node:fs/promises");
                await rm(lockPath(), { force: true }).catch(() => undefined);
            }
            release();
        }
    }
    async function append(entry) {
        const existing = await readAll();
        if (!existing.ok)
            return existing;
        const transition = validateTransition(existing.value, entry);
        if (!transition.ok)
            return transition;
        try {
            await appendFile(ledgerPath(), `${JSON.stringify(entry)}\n`, "utf8");
        }
        catch {
            return { ok: false, code: "ledger_unreadable" };
        }
        return { ok: true, value: entry };
    }
    async function reserve(request) {
        try {
            return await withWriteLock(async () => {
                const existing = await readAll();
                if (!existing.ok)
                    return existing;
                const permitted = canReserve(existing.value, request);
                if (!permitted.ok)
                    return permitted;
                const entry = {
                    reservationId: request.reservationId,
                    utcMonth: request.utcMonth.length === 0 ? utcMonthOf(request.recordedAtUtc) : request.utcMonth,
                    kind: "reserved",
                    runId: request.runId,
                    sessionId: request.sessionId,
                    recordedAtUtc: request.recordedAtUtc,
                    chargeUsd: null,
                };
                return append(entry);
            });
        }
        catch (error) {
            if (isLedgerLockError(error))
                return { ok: false, code: "ledger_unreadable" };
            throw error;
        }
    }
    async function record(entry) {
        try {
            return await withWriteLock(async () => append(entry));
        }
        catch (error) {
            if (isLedgerLockError(error))
                return { ok: false, code: "ledger_unreadable" };
            throw error;
        }
    }
    async function isUncertain(reservationId) {
        const existing = await readAll();
        if (!existing.ok)
            return true;
        return isChargeUncertain(existing.value, reservationId);
    }
    return { readAll, reserve, record, isUncertain };
}
/** A deterministic reservation id from durable facts, so replies are idempotent. */
export function makeReservationId(input) {
    return createHash("sha256")
        .update(`${input.sessionId}\u0000${input.runId}\u0000${input.toolCallId}\u0000${input.query}`)
        .digest("hex")
        .slice(0, 32);
}
function isNotFound(error) {
    return (typeof error === "object" && error !== null && error.code === "ENOENT");
}
function isLockHeld(error) {
    return (typeof error === "object" && error !== null && error.code === "EEXIST");
}
function isLedgerLockError(error) {
    return (typeof error === "object" &&
        error !== null &&
        error.message === "ledger_locked");
}
function isLedgerEntry(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    const kind = record["kind"];
    return (typeof record["reservationId"] === "string" &&
        typeof record["utcMonth"] === "string" &&
        typeof record["runId"] === "string" &&
        typeof record["sessionId"] === "string" &&
        typeof record["recordedAtUtc"] === "string" &&
        (record["chargeUsd"] === null || typeof record["chargeUsd"] === "number") &&
        (kind === "reserved" || kind === "possibly_sent" || kind === "reported" || kind === "uncertain"));
}
