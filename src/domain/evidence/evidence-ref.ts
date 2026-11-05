/**
 * Typed evidence references (V1_DESIGN_SUPPLEMENTS.md S01 section 6.1).
 *
 * C06 separates four things that are easy to conflate: execution outcome,
 * evidence completeness, result delivery, and task verification. This module
 * models the second one only.
 *
 * The forms are mutually exclusive on purpose. The rejected older proposal allowed
 * `kind: "file"` with an optional range, which made "I read something in that file"
 * indistinguishable from "I read these exact lines of this exact snapshot". That
 * ambiguity is what lets an unverified claim look sourced.
 *
 * A reference being present is not the same as evidence being usable. A missing
 * attachment, a hash mismatch and a truncated capture are all represented, and a
 * consumer must treat them as unavailable evidence rather than as success.
 */

export type EvidenceUnavailableReason =
  | "attachment_missing"
  | "hash_mismatch"
  /** The capture stopped at a hard cap, so the range is not the whole object. */
  | "capture_truncated"
  | "snapshot_superseded"
  /** The content was blocked from storage, so no attachment can back this claim. */
  | "content_not_stored";

export type EventEvidence = Readonly<{
  kind: "event";
  sessionId: string;
  eventId: string;
  seq: number;
}>;

export type AttachmentEvidence = Readonly<{
  kind: "attachment_bytes";
  attachmentId: string;
  sha256: string;
  /** Total published byte length of the attachment. */
  byteLength: number;
  /** Half-open byte range. `0 <= start <= end <= byteLength`. */
  start: number;
  end: number;
}>;

export type FileLinesEvidence = Readonly<{
  kind: "file_lines";
  /** Snapshot identity of the read, not a path that may have changed since. */
  snapshotId: string;
  sourceSha256: string;
  encoding: string;
  bom: boolean;
  lineEnding: "lf" | "crlf" | "mixed" | "none";
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
}>;

export type WholeFileEvidence = Readonly<{
  kind: "whole_file";
  snapshotId: string;
  sourceSha256: string;
  /** Complete capture must be proven; a truncated read cannot claim the whole file. */
  captureComplete: boolean;
}>;

export type BackgroundStreamEvidence = Readonly<{
  kind: "background_stream";
  processExecutionId: string;
  stream: "stdout" | "stderr";
  /** Cursor bound to this execution and stream. */
  byteStart: number;
  byteEnd: number;
  attachmentId: string | null;
}>;

export type EvidenceRef =
  | EventEvidence
  | AttachmentEvidence
  | FileLinesEvidence
  | WholeFileEvidence
  | BackgroundStreamEvidence;

/**
 * Evidence that exists as a reference but cannot currently support a claim.
 * Kept separate rather than dropped, because losing it would hide the gap.
 */
export type UnavailableEvidence = Readonly<{
  ref: EvidenceRef;
  reason: EvidenceUnavailableReason;
}>;

export type EvidenceFailure =
  | "invalid_reference"
  | "range_inverted"
  | "range_exceeds_object"
  | "empty_file_range"
  | "incomplete_whole_file"
  | "missing_locator";

export type EvidenceValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: EvidenceFailure; detail?: string }>;

/** Structural validation of a single reference. */
export function validateEvidenceRef(ref: EvidenceRef): EvidenceValidation {
  switch (ref.kind) {
    case "event":
      if (ref.sessionId.length === 0 || ref.eventId.length === 0) {
        return { ok: false, code: "missing_locator", detail: "event" };
      }
      if (!Number.isSafeInteger(ref.seq) || ref.seq < 1) {
        return { ok: false, code: "missing_locator", detail: "event seq" };
      }
      return { ok: true };

    case "attachment_bytes":
      if (ref.attachmentId.length === 0 || !isHex64(ref.sha256)) {
        return { ok: false, code: "missing_locator", detail: "attachment" };
      }
      if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
        return { ok: false, code: "invalid_reference", detail: "byteLength" };
      }
      if (
        !Number.isSafeInteger(ref.start) ||
        !Number.isSafeInteger(ref.end) ||
        ref.start < 0 ||
        ref.end < 0
      ) {
        return { ok: false, code: "invalid_reference", detail: "range" };
      }
      if (ref.start > ref.end) return { ok: false, code: "range_inverted" };
      if (ref.end > ref.byteLength) {
        return { ok: false, code: "range_exceeds_object" };
      }
      return { ok: true };

    case "file_lines":
      if (ref.snapshotId.length === 0 || !isHex64(ref.sourceSha256)) {
        return { ok: false, code: "missing_locator", detail: "file_lines" };
      }
      if (!Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine)) {
        return { ok: false, code: "invalid_reference", detail: "line range" };
      }
      // 1-based: a zero or negative line is not a line.
      if (ref.startLine < 1) return { ok: false, code: "invalid_reference", detail: "startLine" };
      if (ref.startLine > ref.endLine) return { ok: false, code: "range_inverted" };
      // An empty file is expressed as whole_file, never as an inverted line range.
      if (ref.lineEnding === "none" && ref.startLine !== 1) {
        return { ok: false, code: "empty_file_range" };
      }
      return { ok: true };

    case "whole_file":
      if (ref.snapshotId.length === 0 || !isHex64(ref.sourceSha256)) {
        return { ok: false, code: "missing_locator", detail: "whole_file" };
      }
      // A truncated capture must not be presented as the whole file.
      if (!ref.captureComplete) return { ok: false, code: "incomplete_whole_file" };
      return { ok: true };

    case "background_stream":
      if (ref.processExecutionId.length === 0) {
        return { ok: false, code: "missing_locator", detail: "processExecutionId" };
      }
      if (
        !Number.isSafeInteger(ref.byteStart) ||
        !Number.isSafeInteger(ref.byteEnd) ||
        ref.byteStart < 0 ||
        ref.byteEnd < 0
      ) {
        return { ok: false, code: "invalid_reference", detail: "cursor" };
      }
      if (ref.byteStart > ref.byteEnd) return { ok: false, code: "range_inverted" };
      return { ok: true };
  }
}

/**
 * A locator that is bound to a specific snapshot must also match the hash of that
 * snapshot. Two reads of the same path produce different snapshots, and an old
 * pass must not silently attach to a new file version.
 */
export function evidenceMatchesSnapshot(
  ref: EvidenceRef,
  snapshot: Readonly<{ snapshotId: string; sourceSha256: string }>,
): boolean {
  if (ref.kind === "file_lines" || ref.kind === "whole_file") {
    return ref.snapshotId === snapshot.snapshotId && ref.sourceSha256 === snapshot.sourceSha256;
  }
  // Event, attachment and background-stream evidence are bound by their own ids,
  // not by a file snapshot.
  return true;
}

/**
 * Whether a set of references contains at least one usable citation. Empty byte
 * ranges are legal but do not prove that any content was read, so they do not
 * count as substantive evidence.
 */
export function hasSubstantiveEvidence(refs: readonly EvidenceRef[]): boolean {
  return refs.some((ref) => {
    if (!validateEvidenceRef(ref).ok) return false;
    if (ref.kind === "attachment_bytes") return ref.end > ref.start;
    if (ref.kind === "background_stream") return ref.byteEnd > ref.byteStart;
    return true;
  });
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
