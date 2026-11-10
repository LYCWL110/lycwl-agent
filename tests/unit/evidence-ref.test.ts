import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  type EvidenceRef,
  evidenceMatchesSnapshot,
  hasSubstantiveEvidence,
  validateEvidenceRef,
} from "../../src/domain/evidence/evidence-ref.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEX = sha256("x");

describe("evidence reference validation", () => {
  it("accepts a well-formed event reference", () => {
    assert.deepEqual(validateEvidenceRef({ kind: "event", sessionId: "s", eventId: "e", seq: 1 }), {
      ok: true,
    });
  });

  it("rejects an event reference without a session or event id", () => {
    assert.equal(
      validateEvidenceRef({ kind: "event", sessionId: "", eventId: "e", seq: 1 }).ok,
      false,
    );
    assert.equal(
      validateEvidenceRef({ kind: "event", sessionId: "s", eventId: "", seq: 1 }).ok,
      false,
    );
  });

  it("rejects a non-positive event seq", () => {
    assert.equal(
      validateEvidenceRef({ kind: "event", sessionId: "s", eventId: "e", seq: 0 }).ok,
      false,
    );
  });

  it("accepts an in-range attachment range", () => {
    assert.deepEqual(
      validateEvidenceRef({
        kind: "attachment_bytes",
        attachmentId: "a",
        sha256: HEX,
        byteLength: 10,
        start: 0,
        end: 10,
      }),
      { ok: true },
    );
  });

  it("rejects an inverted attachment range", () => {
    const result = validateEvidenceRef({
      kind: "attachment_bytes",
      attachmentId: "a",
      sha256: HEX,
      byteLength: 10,
      start: 8,
      end: 2,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "range_inverted");
  });

  it("rejects a range beyond the attachment length", () => {
    const result = validateEvidenceRef({
      kind: "attachment_bytes",
      attachmentId: "a",
      sha256: HEX,
      byteLength: 10,
      start: 0,
      end: 11,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "range_exceeds_object");
  });

  it("rejects an attachment reference with a malformed hash", () => {
    const result = validateEvidenceRef({
      kind: "attachment_bytes",
      attachmentId: "a",
      sha256: "nope",
      byteLength: 10,
      start: 0,
      end: 1,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "missing_locator");
  });

  it("accepts a 1-based inclusive line range", () => {
    assert.deepEqual(
      validateEvidenceRef({
        kind: "file_lines",
        snapshotId: "snap-1",
        sourceSha256: HEX,
        encoding: "utf8",
        bom: false,
        lineEnding: "lf",
        startLine: 1,
        endLine: 10,
      }),
      { ok: true },
    );
  });

  it("rejects a zero or negative start line", () => {
    const result = validateEvidenceRef({
      kind: "file_lines",
      snapshotId: "snap-1",
      sourceSha256: HEX,
      encoding: "utf8",
      bom: false,
      lineEnding: "lf",
      startLine: 0,
      endLine: 10,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_reference");
  });

  it("rejects an inverted line range", () => {
    const result = validateEvidenceRef({
      kind: "file_lines",
      snapshotId: "snap-1",
      sourceSha256: HEX,
      encoding: "utf8",
      bom: false,
      lineEnding: "lf",
      startLine: 10,
      endLine: 2,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "range_inverted");
  });

  it("rejects a non-1 start line for an empty file", () => {
    const result = validateEvidenceRef({
      kind: "file_lines",
      snapshotId: "snap-1",
      sourceSha256: HEX,
      encoding: "utf8",
      bom: false,
      lineEnding: "none",
      startLine: 2,
      endLine: 2,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "empty_file_range");
  });

  it("accepts a complete whole-file reference", () => {
    assert.deepEqual(
      validateEvidenceRef({
        kind: "whole_file",
        snapshotId: "snap-1",
        sourceSha256: HEX,
        captureComplete: true,
      }),
      { ok: true },
    );
  });

  it("rejects a truncated whole-file claim", () => {
    const result = validateEvidenceRef({
      kind: "whole_file",
      snapshotId: "snap-1",
      sourceSha256: HEX,
      captureComplete: false,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "incomplete_whole_file");
  });

  it("accepts a background stream range", () => {
    assert.deepEqual(
      validateEvidenceRef({
        kind: "background_stream",
        processExecutionId: "exec-1",
        stream: "stdout",
        byteStart: 0,
        byteEnd: 100,
        attachmentId: null,
      }),
      { ok: true },
    );
  });

  it("rejects an inverted background cursor", () => {
    const result = validateEvidenceRef({
      kind: "background_stream",
      processExecutionId: "exec-1",
      stream: "stdout",
      byteStart: 100,
      byteEnd: 0,
      attachmentId: null,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "range_inverted");
  });
});

describe("snapshot binding", () => {
  const ref: EvidenceRef = {
    kind: "file_lines",
    snapshotId: "snap-1",
    sourceSha256: HEX,
    encoding: "utf8",
    bom: false,
    lineEnding: "lf",
    startLine: 1,
    endLine: 5,
  };

  it("matches only the same snapshot id and hash", () => {
    assert.equal(evidenceMatchesSnapshot(ref, { snapshotId: "snap-1", sourceSha256: HEX }), true);
    assert.equal(evidenceMatchesSnapshot(ref, { snapshotId: "snap-2", sourceSha256: HEX }), false);
    assert.equal(
      evidenceMatchesSnapshot(ref, { snapshotId: "snap-1", sourceSha256: sha256("y") }),
      false,
    );
  });

  it("does not bind an event reference to a file snapshot", () => {
    assert.equal(
      evidenceMatchesSnapshot(
        { kind: "event", sessionId: "s", eventId: "e", seq: 1 },
        { snapshotId: "other", sourceSha256: sha256("y") },
      ),
      true,
    );
  });
});

describe("substantive evidence", () => {
  it("treats an empty byte range as non-substantive", () => {
    assert.equal(
      hasSubstantiveEvidence([
        {
          kind: "attachment_bytes",
          attachmentId: "a",
          sha256: HEX,
          byteLength: 10,
          start: 5,
          end: 5,
        },
      ]),
      false,
    );
  });

  it("treats a non-empty range as substantive", () => {
    assert.equal(
      hasSubstantiveEvidence([
        {
          kind: "attachment_bytes",
          attachmentId: "a",
          sha256: HEX,
          byteLength: 10,
          start: 0,
          end: 10,
        },
      ]),
      true,
    );
  });

  it("treats an invalid reference as non-substantive", () => {
    assert.equal(
      hasSubstantiveEvidence([{ kind: "event", sessionId: "", eventId: "e", seq: 1 }]),
      false,
    );
  });
});
