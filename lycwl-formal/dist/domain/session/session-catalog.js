import { isSessionId } from "../identity/session-id.js";
/**
 * Session catalog entries (S02 session list).
 *
 * A session's *execution* state lives in its append-only event log. A user-assigned
 * title does not: it is display metadata, so it lives in a sidecar file beside the
 * log rather than in the hash-chained trail. Putting it in the log would make a
 * rename look like an execution fact and would have to be replayed.
 *
 * This module is pure. It validates titles and derives what to show; it reads and
 * writes nothing.
 */
export const SESSION_TITLE_LIMITS = Object.freeze({
    maxLength: 80,
    /** The derived fallback comes from the first task, which can be long. */
    maxDerivedLength: 60,
    /** The sidecar is small by construction; a larger one is not ours. */
    maxSidecarBytes: 4_096,
    /** Only the head of the log is read to find the first task. */
    maxHeadBytes: 65_536,
    /** Only the tail is read to find the newest event time. */
    maxTailBytes: 32_768,
});
/**
 * Validate a user-supplied title.
 *
 * Control characters are refused rather than stripped: a title containing a newline
 * would break the single-line row it is rendered in, and silently rewriting the
 * user's text would show a title they did not enter.
 */
export function validateSessionTitle(value) {
    if (typeof value !== "string")
        return { ok: false };
    const title = value.trim();
    if (title.length === 0 || title.length > SESSION_TITLE_LIMITS.maxLength)
        return { ok: false };
    // Checked by code point rather than with a regex: a control-character class in a
    // pattern is easy to write incorrectly and is flagged by the linter for that reason.
    for (const character of title) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            return { ok: false };
    }
    return { ok: true, title };
}
/** Collapse whitespace so a multi-line task becomes one row. */
export function collapseWhitespace(value) {
    return value.replace(/\s+/gu, " ").trim();
}
/**
 * The label shown for a session.
 *
 * The precedence is deliberate: an explicit title wins, then the first task, then
 * the id. The id is never hidden, because it is what `--resume` needs.
 */
export function sessionLabel(summary) {
    if (summary.title !== null)
        return summary.title;
    if (summary.firstInput !== null) {
        const collapsed = collapseWhitespace(summary.firstInput);
        if (collapsed.length > 0) {
            return collapsed.length > SESSION_TITLE_LIMITS.maxDerivedLength
                ? `${collapsed.slice(0, SESSION_TITLE_LIMITS.maxDerivedLength - 1)}…`
                : collapsed;
        }
    }
    return summary.sessionId;
}
/** Parse the sidecar document. A damaged sidecar yields no title, never an error. */
export function readSidecarTitle(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const title = parsed["title"];
    const validated = validateSessionTitle(title);
    return validated.ok ? validated.title : null;
}
/** Serialize the sidecar. Written whole, so it never accumulates stale fields. */
export function serializeSidecar(title, renamedAtUtc) {
    return `${JSON.stringify({ title, renamedAtUtc }, null, 2)}\n`;
}
/**
 * Extract the first task text from the head of a log.
 *
 * Only complete lines are parsed, so a truncated final line is ignored rather than
 * reported as corruption. The first `run_started` is the session's opening task.
 */
export function firstInputFromHead(head) {
    for (const line of head.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (typeof parsed !== "object" || parsed === null)
            continue;
        const payload = parsed["payload"];
        if (typeof payload !== "object" || payload === null)
            continue;
        const record = payload;
        if (record["kind"] !== "run_started")
            continue;
        const input = record["input"];
        return typeof input === "string" ? input : null;
    }
    return null;
}
/** Reject anything that is not a single safe path segment before touching disk. */
export function assertSessionId(value) {
    if (!isSessionId(value))
        throw new Error("invalid_session_id");
}
/**
 * The last activity time from the tail of a log.
 *
 * `timestampUtc` on the newest event is the authoritative activity time. A file
 * mtime is not: copying, backing up or restoring a data directory rewrites it, and
 * then every session claims to have been used at the moment of the copy. The event
 * time is what actually happened.
 *
 * The tail is scanned backwards and the newest parseable `timestampUtc` wins. A
 * truncated final line is skipped rather than reported as corruption, because an
 * append interrupted by a crash is exactly what the log is designed to survive.
 */
export function lastActivityFromTail(tail) {
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const trimmed = lines[index]?.trim() ?? "";
        if (trimmed.length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (typeof parsed !== "object" || parsed === null)
            continue;
        const timestamp = parsed["timestampUtc"];
        if (typeof timestamp !== "string")
            continue;
        if (!Number.isFinite(Date.parse(timestamp)))
            continue;
        return timestamp;
    }
    return null;
}
/**
 * Order sessions newest first.
 *
 * A session with no readable timestamp sorts last rather than first: an unknown
 * time must not displace a session known to be recent. The id breaks ties so the
 * order is deterministic, which matters because the panel's selection index is
 * positional.
 */
export function compareSessionsNewestFirst(left, right) {
    const leftTime = Date.parse(left.modifiedAtUtc);
    const rightTime = Date.parse(right.modifiedAtUtc);
    const leftKnown = Number.isFinite(leftTime);
    const rightKnown = Number.isFinite(rightTime);
    if (leftKnown !== rightKnown)
        return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && leftTime !== rightTime)
        return rightTime - leftTime;
    if (left.sessionId === right.sessionId)
        return 0;
    return left.sessionId < right.sessionId ? 1 : -1;
}
