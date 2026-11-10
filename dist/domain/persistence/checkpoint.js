/**
 * Session checkpoint policy (V1_BASELINE section 7). A checkpoint accelerates
 * replay; it never replaces the event log and never rewrites history.
 */
export const CHECKPOINT_INTERVAL_EVENTS = 50;
/** Terminal changes always checkpoint regardless of the interval. */
export const CHECKPOINT_TERMINAL_EVENTS = new Set([
    "run_completed",
    "run_failed",
    "run_cancelled",
    "run_waiting",
]);
export function shouldCheckpoint(eventsSinceCheckpoint, lastEventType) {
    if (lastEventType !== null && CHECKPOINT_TERMINAL_EVENTS.has(lastEventType))
        return true;
    return eventsSinceCheckpoint >= CHECKPOINT_INTERVAL_EVENTS;
}
export function createCheckpoint(sessionId, events, eventsSinceCheckpoint) {
    const last = events.at(-1);
    if (last === undefined)
        return null;
    return {
        schemaVersion: 1,
        sessionId,
        throughSeq: last.seq,
        throughEventId: last.eventId,
        throughHash: last.hash,
        eventsSinceCheckpoint,
        runState: deriveRunState(events),
        safeFailureCode: deriveSafeFailureCode(events),
        toolOutcomes: deriveToolOutcomes(events),
        uncertainDispatches: deriveUncertainDispatches(events),
        modelAttempts: events.filter((event) => event.type === "model_request_started").length,
    };
}
/**
 * A checkpoint is only usable when it verifiably describes a prefix of the
 * current log. Anything else is discarded and rebuilt from events.
 */
export function validateCheckpoint(document, events) {
    if (typeof document !== "object" || document === null) {
        return { ok: false, code: "invalid_document" };
    }
    const record = document;
    const checkpoint = record["checkpoint"];
    if (typeof checkpoint !== "object" || checkpoint === null) {
        return { ok: false, code: "invalid_document" };
    }
    const state = checkpoint;
    if (state["schemaVersion"] !== 1)
        return { ok: false, code: "unknown_schema_version" };
    if (typeof state["sessionId"] !== "string")
        return { ok: false, code: "not_a_checkpoint" };
    if (!Number.isSafeInteger(state["throughSeq"])) {
        return { ok: false, code: "not_a_checkpoint" };
    }
    const throughSeq = state["throughSeq"];
    const covered = events.find((event) => event.seq === throughSeq);
    if (covered === undefined)
        return { ok: false, code: "newer_than_log" };
    if (covered.eventId !== state["throughEventId"] || covered.hash !== state["throughHash"]) {
        return { ok: false, code: "hash_mismatch" };
    }
    return { ok: true, value: checkpoint };
}
/**
 * Events a caller must still replay after applying a checkpoint.
 */
export function eventsAfterCheckpoint(events, checkpoint) {
    return events.filter((event) => event.seq > checkpoint.throughSeq);
}
function deriveRunState(events) {
    let state = "active";
    for (const event of events) {
        switch (event.type) {
            case "run_started":
            case "run_resumed":
                state = "active";
                break;
            case "run_waiting":
                state = "waiting";
                break;
            case "run_completed":
                state = "completed";
                break;
            case "run_failed":
                state = "failed";
                break;
            case "run_cancelled":
                state = "cancelled";
                break;
            default:
                break;
        }
    }
    return state;
}
function deriveSafeFailureCode(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const payload = events[index]?.payload;
        if (payload === undefined)
            continue;
        if (payload.kind === "run_failed" || payload.kind === "run_cancelled") {
            return payload.safeCode;
        }
        if (payload.kind === "run_waiting")
            return payload.safeCode;
        if (payload.kind === "run_completed")
            return null;
    }
    return null;
}
function deriveToolOutcomes(events) {
    const outcomes = {};
    for (const event of events) {
        if (event.payload.kind === "tool_execution_finished") {
            outcomes[event.payload.toolCallId] = event.payload.status;
        }
        else if (event.payload.kind === "tool_execution_denied") {
            outcomes[event.payload.toolCallId] = "denied";
        }
        else if (event.payload.kind === "tool_call_cancelled") {
            outcomes[event.payload.toolCallId] = "cancelled";
        }
    }
    return outcomes;
}
function deriveUncertainDispatches(events) {
    const open = new Set();
    for (const event of events) {
        const payload = event.payload;
        if (payload.kind === "tool_dispatch_committed")
            open.add(payload.toolCallId);
        else if (payload.kind === "tool_execution_finished" ||
            payload.kind === "tool_execution_denied" ||
            payload.kind === "tool_call_cancelled") {
            open.delete(payload.toolCallId);
        }
    }
    return [...open];
}
