import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  canReserve,
  isChargeUncertain,
  type LedgerEntry,
  type LedgerEntryKind,
  type LedgerFailure,
  type LedgerResult,
  type ReservationRequest,
  utcMonthOf,
  validateTransition,
} from "../../domain/web/search-ledger.ts";
import { linuxDirectories } from "../linux/directories.ts";

/**
 * Durable append-only search ledger (C07).
 *
 * Location follows the confirmed layout:
 * `%LOCALAPPDATA%\lycwl-agent\search-usage\`.
 *
 * Fail-closed rules:
 * - an unreadable or corrupt ledger disables search rather than falling back to
 *   an in-memory counter;
 * - a reservation is written and flushed before the caller may send anything;
 * - a lock is taken per file so two Harness instances cannot double-reserve.
 */

export type LedgerReadFailure = "ledger_unreadable" | "ledger_corrupt";

export type SearchLedger = Readonly<{
  /** Read every recorded entry; fails closed instead of guessing. */
  readAll: () => Promise<LedgerResult<readonly LedgerEntry[]>>;
  /** Reserve a quota slot before dispatch. Returns the new entry on success. */
  reserve: (request: ReservationRequest) => Promise<LedgerResult<LedgerEntry>>;
  /** Record a later fact for an existing reservation. */
  record: (entry: LedgerEntry) => Promise<LedgerResult<LedgerEntry>>;
  /** Whether a reservation was closed as possibly charged. */
  isUncertain: (reservationId: string) => Promise<boolean>;
}>;

export type SearchLedgerOptions = Readonly<{
  /** Directory holding the ledger; defaults to the confirmed location. */
  directory?: string;
  /** Injected clock for deterministic tests. */
  nowUtc?: () => string;
}>;

export function defaultSearchLedgerDirectory(): string {
  if (process.platform === "linux") return path.join(linuxDirectories().state, "search-usage");
  const localAppData = process.env["LOCALAPPDATA"];
  const base =
    localAppData === undefined || localAppData.length === 0
      ? path.join(process.cwd(), ".lycwl-agent")
      : path.join(localAppData, "lycwl-agent");
  return path.join(base, "search-usage");
}

export function createSearchLedger(options: SearchLedgerOptions = {}): SearchLedger {
  const directory = options.directory ?? defaultSearchLedgerDirectory();
  let writeTail: Promise<void> = Promise.resolve();

  function ledgerPath(): string {
    return path.join(directory, "search-ledger.jsonl");
  }

  function lockPath(): string {
    return path.join(directory, "search-ledger.lock");
  }

  async function readAll(): Promise<LedgerResult<readonly LedgerEntry[]>> {
    let raw: string;
    try {
      raw = await readFile(ledgerPath(), "utf8");
    } catch (error) {
      if (isNotFound(error)) return { ok: true, value: [] };
      return { ok: false, code: "ledger_unreadable" };
    }

    const entries: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A corrupt line disables search: the quota can no longer be trusted.
        return { ok: false, code: "ledger_corrupt" };
      }
      if (!isLedgerEntry(parsed)) return { ok: false, code: "ledger_corrupt" };
      entries.push(parsed);
    }
    return { ok: true, value: entries };
  }

  /** Serialize writers within this process and guard against another instance. */
  async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeTail;
    let release: () => void = () => undefined;
    writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    let lockHandle: Awaited<ReturnType<typeof import("node:fs/promises").open>> | null = null;
    try {
      await mkdir(directory, { recursive: true });
      const { open } = await import("node:fs/promises");
      // `wx` fails if another instance holds the lock; that is a fail-closed
      // condition, not a reason to proceed unlocked.
      lockHandle = await open(lockPath(), "wx");
      return await operation();
    } catch (error) {
      if (isLockHeld(error)) {
        throw Object.assign(new Error("ledger_locked"), { code: "ledger_locked" });
      }
      throw error;
    } finally {
      if (lockHandle !== null) {
        await lockHandle.close().catch(() => undefined);
        const { rm } = await import("node:fs/promises");
        await rm(lockPath(), { force: true }).catch(() => undefined);
      }
      release();
    }
  }

  async function append(entry: LedgerEntry): Promise<LedgerResult<LedgerEntry>> {
    const existing = await readAll();
    if (!existing.ok) return existing;

    const transition = validateTransition(existing.value, entry);
    if (!transition.ok) return transition;

    try {
      await appendFile(ledgerPath(), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      return { ok: false, code: "ledger_unreadable" };
    }
    return { ok: true, value: entry };
  }

  async function reserve(request: ReservationRequest): Promise<LedgerResult<LedgerEntry>> {
    try {
      return await withWriteLock(async () => {
        const existing = await readAll();
        if (!existing.ok) return existing;

        const permitted = canReserve(existing.value, request);
        if (!permitted.ok) return permitted;

        const entry: LedgerEntry = {
          reservationId: request.reservationId,
          utcMonth:
            request.utcMonth.length === 0 ? utcMonthOf(request.recordedAtUtc) : request.utcMonth,
          kind: "reserved",
          runId: request.runId,
          sessionId: request.sessionId,
          recordedAtUtc: request.recordedAtUtc,
          chargeUsd: null,
        };
        return append(entry);
      });
    } catch (error) {
      if (isLedgerLockError(error)) return { ok: false, code: "ledger_unreadable" };
      throw error;
    }
  }

  async function record(entry: LedgerEntry): Promise<LedgerResult<LedgerEntry>> {
    try {
      return await withWriteLock(async () => append(entry));
    } catch (error) {
      if (isLedgerLockError(error)) return { ok: false, code: "ledger_unreadable" };
      throw error;
    }
  }

  async function isUncertain(reservationId: string): Promise<boolean> {
    const existing = await readAll();
    if (!existing.ok) return true;
    return isChargeUncertain(existing.value, reservationId);
  }

  return { readAll, reserve, record, isUncertain };
}

/** A deterministic reservation id from durable facts, so replies are idempotent. */
export function makeReservationId(
  input: Readonly<{
    sessionId: string;
    runId: string;
    toolCallId: string;
    query: string;
  }>,
): string {
  return createHash("sha256")
    .update(`${input.sessionId}\u0000${input.runId}\u0000${input.toolCallId}\u0000${input.query}`)
    .digest("hex")
    .slice(0, 32);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function isLockHeld(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

function isLedgerLockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { message?: unknown }).message === "ledger_locked"
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  return (
    typeof record["reservationId"] === "string" &&
    typeof record["utcMonth"] === "string" &&
    typeof record["runId"] === "string" &&
    typeof record["sessionId"] === "string" &&
    typeof record["recordedAtUtc"] === "string" &&
    (record["chargeUsd"] === null || typeof record["chargeUsd"] === "number") &&
    (kind === "reserved" || kind === "possibly_sent" || kind === "reported" || kind === "uncertain")
  );
}

export type { LedgerEntry, LedgerEntryKind, LedgerFailure };
