import { isSessionId } from "../identity/session-id.ts";

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
});

export type SessionSummary = Readonly<{
  sessionId: string;
  /** The user-assigned title, when one was set. */
  title: string | null;
  /** The first task text, when the log has a `run_started` event. */
  firstInput: string | null;
  /** Size of `events.jsonl` in bytes. */
  bytes: number;
  /** Last write to `events.jsonl`. */
  modifiedAtUtc: string;
}>;

export type SessionCatalogFailure =
  | "invalid_session_id"
  | "invalid_title"
  | "session_not_found"
  | "session_in_use"
  | "not_a_session"
  | "write_failed"
  | "delete_failed";

export type SessionCatalogResult =
  | Readonly<{ ok: true; sessions: readonly SessionSummary[] }>
  | Readonly<{ ok: false; code: SessionCatalogFailure }>;

/**
 * Validate a user-supplied title.
 *
 * Control characters are refused rather than stripped: a title containing a newline
 * would break the single-line row it is rendered in, and silently rewriting the
 * user's text would show a title they did not enter.
 */
export function validateSessionTitle(
  value: unknown,
): Readonly<{ ok: true; title: string }> | Readonly<{ ok: false }> {
  if (typeof value !== "string") return { ok: false };
  const title = value.trim();
  if (title.length === 0 || title.length > SESSION_TITLE_LIMITS.maxLength) return { ok: false };
  // Checked by code point rather than with a regex: a control-character class in a
  // pattern is easy to write incorrectly and is flagged by the linter for that reason.
  for (const character of title) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { ok: false };
  }
  return { ok: true, title };
}

/** Collapse whitespace so a multi-line task becomes one row. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * The label shown for a session.
 *
 * The precedence is deliberate: an explicit title wins, then the first task, then
 * the id. The id is never hidden, because it is what `--resume` needs.
 */
export function sessionLabel(summary: SessionSummary): string {
  if (summary.title !== null) return summary.title;
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
export function readSidecarTitle(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const title = (parsed as Record<string, unknown>)["title"];
  const validated = validateSessionTitle(title);
  return validated.ok ? validated.title : null;
}

/** Serialize the sidecar. Written whole, so it never accumulates stale fields. */
export function serializeSidecar(title: string, renamedAtUtc: string): string {
  return `${JSON.stringify({ title, renamedAtUtc }, null, 2)}\n`;
}

/**
 * Extract the first task text from the head of a log.
 *
 * Only complete lines are parsed, so a truncated final line is ignored rather than
 * reported as corruption. The first `run_started` is the session's opening task.
 */
export function firstInputFromHead(head: string): string | null {
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const payload = (parsed as Record<string, unknown>)["payload"];
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record["kind"] !== "run_started") continue;
    const input = record["input"];
    return typeof input === "string" ? input : null;
  }
  return null;
}

/** Reject anything that is not a single safe path segment before touching disk. */
export function assertSessionId(value: string): void {
  if (!isSessionId(value)) throw new Error("invalid_session_id");
}
