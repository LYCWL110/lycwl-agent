/**
 * Paid-search quota ledger (C07).
 *
 * Search is metered even on a free tier, so a call is only permitted after a
 * durable reservation. The ledger is append-only, scoped to a UTC calendar
 * month, and shared across Sessions and instances for one local user.
 *
 * Rules this module enforces:
 * - reserve before send; sending without a reservation is prohibited;
 * - a crash may overcount an unused slot, but must never undercount;
 * - an uncertain charge is never refunded or automatically retried;
 * - a lock, read or parse failure disables search instead of falling back to an
 *   in-memory counter.
 */
export const SEARCH_LEDGER_LIMITS = Object.freeze({
    callsPerRun: 10,
    callsPerUtcMonth: 100,
    /** Retention window for ledger entries; keeps the file bounded per month. */
    retainedMonths: 2,
});
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const VALID_NEXT = {
    reserved: ["possibly_sent", "uncertain", "reserved"],
    possibly_sent: ["reported", "uncertain"],
    reported: [],
    uncertain: [],
};
export function utcMonthOf(timestampUtc) {
    return timestampUtc.slice(0, 7);
}
export function validateLedgerEntry(entry) {
    if (entry.reservationId.length === 0)
        return "invalid_entry";
    if (!MONTH_PATTERN.test(entry.utcMonth))
        return "invalid_entry";
    if (entry.runId.length === 0 || entry.sessionId.length === 0)
        return "invalid_entry";
    if (Number.isNaN(Date.parse(entry.recordedAtUtc)))
        return "invalid_entry";
    if (entry.chargeUsd !== null && (!Number.isFinite(entry.chargeUsd) || entry.chargeUsd < 0)) {
        return "invalid_entry";
    }
    if (entry.kind === "reported" && entry.chargeUsd === null) {
        // A reported charge must be a real number; unknown is represented by
        // `uncertain`, never by zero.
        return "invalid_entry";
    }
    return null;
}
/** Count the quota a set of entries consumes for one month and one Run. */
export function computeLedgerState(entries, utcMonth, runId) {
    const reservations = new Map();
    for (const entry of entries) {
        if (entry.kind !== "reserved")
            continue;
        if (entry.utcMonth !== utcMonth)
            continue;
        reservations.set(entry.reservationId, entry);
    }
    let reservedInRun = 0;
    for (const entry of reservations.values()) {
        if (entry.runId === runId)
            reservedInRun += 1;
    }
    return { reservedInMonth: reservations.size, reservedInRun };
}
/**
 * Decide whether a new reservation may be made. This is the pre-send gate: a
 * false result means the call must not be dispatched at all.
 */
export function canReserve(entries, request) {
    if (request.reservationId.length === 0)
        return { ok: false, code: "invalid_entry" };
    if (!MONTH_PATTERN.test(request.utcMonth))
        return { ok: false, code: "invalid_entry" };
    if (entries.some((entry) => entry.reservationId === request.reservationId)) {
        return { ok: false, code: "duplicate_reservation" };
    }
    const state = computeLedgerState(entries, request.utcMonth, request.runId);
    if (state.reservedInRun >= SEARCH_LEDGER_LIMITS.callsPerRun) {
        return { ok: false, code: "run_limit" };
    }
    if (state.reservedInMonth >= SEARCH_LEDGER_LIMITS.callsPerUtcMonth) {
        return { ok: false, code: "monthly_limit" };
    }
    return { ok: true, value: { state } };
}
/**
 * Validate a follow-up state entry for an existing reservation. `reserved` may
 * only repeat for the same reservation identity, never create a second slot.
 */
export function validateTransition(entries, next) {
    const entryFailure = validateLedgerEntry(next);
    if (entryFailure !== null)
        return { ok: false, code: entryFailure };
    const existing = entries.filter((entry) => entry.reservationId === next.reservationId);
    if (existing.length === 0) {
        if (next.kind !== "reserved")
            return { ok: false, code: "unknown_reservation" };
        return { ok: true, value: next };
    }
    const latest = existing.at(-1);
    if (latest === undefined)
        return { ok: false, code: "unknown_reservation" };
    if (latest.kind === next.kind) {
        // Repeating the identical terminal state is idempotent.
        if (latest.kind === "reported" || latest.kind === "uncertain") {
            return { ok: true, value: next };
        }
        return { ok: false, code: "invalid_state_transition" };
    }
    if (!VALID_NEXT[latest.kind].includes(next.kind)) {
        return { ok: false, code: "invalid_state_transition" };
    }
    return { ok: true, value: next };
}
/** Whether a reservation was closed as perhaps-charged and must not be retried. */
export function isChargeUncertain(entries, reservationId) {
    const latest = entries.filter((entry) => entry.reservationId === reservationId).at(-1);
    return latest?.kind === "uncertain";
}
/** Sum reported charges for one month. Unknown charges contribute nothing. */
export function reportedChargeUsd(entries, utcMonth) {
    let total = 0;
    for (const entry of entries) {
        if (entry.kind !== "reported" || entry.utcMonth !== utcMonth)
            continue;
        total += entry.chargeUsd ?? 0;
    }
    return total;
}
