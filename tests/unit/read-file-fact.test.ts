import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  createReadFileEvidence,
  createReadFileEvidenceRef,
  createReadFileFact,
} from "../../src/services/files/read-file-fact.ts";
import { boundTextSnapshotForModel } from "../../src/services/files/text-delivery.ts";
import { readTextSnapshot } from "../../src/services/files/text-snapshot.ts";

function delivery(content: string, lineCount = 200) {
  const result = readTextSnapshot(Buffer.from(content, "utf8"), { lineCount });
  if (!result.ok) throw new Error(result.code);
  return boundTextSnapshotForModel(result.value);
}

describe("read_file facts", () => {
  it("builds an inclusive line slice with byte and delivery evidence", () => {
    const fact = createReadFileFact("snapshot-1", delivery("one\r\ntwo\nthree"));
    assert.equal(fact.snapshot.snapshotId, "snapshot-1");
    assert.equal(fact.snapshot.lineEndings, "mixed");
    assert.deepEqual(fact.slice, {
      kind: "lines",
      startLine: 1,
      endLine: 3,
      byteRange: { start: 0, end: 14 },
      fullLines: true,
      deliveredByteRange: { start: 0, end: 14 },
    });
    assert.equal(fact.content, "one\r\ntwo\nthree");
    assert.equal(fact.textTruncated, false);
  });

  it("marks a model-truncated long line as incomplete", () => {
    const fact = createReadFileFact("snapshot-2", delivery("a".repeat(20_001)));
    assert.equal(fact.content, "a".repeat(20_000));
    assert.equal(fact.textTruncated, true);
    assert.equal(fact.slice.kind, "lines");
    if (fact.slice.kind !== "lines") return;
    assert.equal(fact.slice.fullLines, false);
    assert.deepEqual(fact.slice.byteRange, { start: 0, end: 20_001 });
    assert.deepEqual(fact.slice.deliveredByteRange, { start: 0, end: 20_000 });
  });

  it("uses an empty slice beyond EOF", () => {
    const result = readTextSnapshot(Buffer.from("one\n", "utf8"), {
      startLine: 3,
      lineCount: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const fact = createReadFileFact("snapshot-3", boundTextSnapshotForModel(result.value));
    assert.deepEqual(fact.slice, { kind: "empty", atLine: 3 });
    assert.equal(fact.content, "");
    assert.equal(fact.textTruncated, false);
  });

  it("claims complete raw evidence only for a matching published attachment", () => {
    const fact = createReadFileFact("snapshot-1", delivery("hello"));
    const complete = createReadFileEvidence(fact, {
      attachmentId: "attachment-1",
      sha256: fact.snapshot.fileSha256,
      byteLength: fact.snapshot.totalBytes,
      mediaKind: "text/plain",
      publicationStatus: "published",
    });
    assert.equal(complete.rawComplete, true);
    assert.equal(complete.rawTruncationReason, null);
    assert.equal(complete.attachmentRefs.length, 1);

    const missing = createReadFileEvidence(fact, null);
    assert.equal(missing.rawComplete, false);
    assert.equal(missing.rawTruncationReason, "capture_interrupted");
    assert.deepEqual(missing.attachmentRefs, []);

    const mismatched = createReadFileEvidence(fact, {
      attachmentId: "attachment-1",
      sha256: "0".repeat(64),
      byteLength: fact.snapshot.totalBytes,
      mediaKind: "text/plain",
      publicationStatus: "published",
    });
    assert.equal(mismatched.rawComplete, false);
    assert.deepEqual(mismatched.attachmentRefs, []);
  });

  it("uses whole_file for empty files and file_lines for non-empty slices", () => {
    const emptyFact = createReadFileFact("snapshot-empty", delivery(""));
    const emptyAttachment = {
      attachmentId: "attachment-empty",
      sha256: emptyFact.snapshot.fileSha256,
      byteLength: 0,
      mediaKind: "text/plain" as const,
      publicationStatus: "published" as const,
    };
    const empty = createReadFileEvidenceRef(emptyFact, emptyAttachment);
    assert.equal(empty?.kind, "whole_file");
    if (empty?.kind !== "whole_file") return;
    assert.equal(empty.snapshot.totalBytes, 0);

    const linesFact = createReadFileFact("snapshot-lines", delivery("one\ntwo\n"));
    const linesAttachment = {
      attachmentId: "attachment-lines",
      sha256: linesFact.snapshot.fileSha256,
      byteLength: linesFact.snapshot.totalBytes,
      mediaKind: "text/plain" as const,
      publicationStatus: "published" as const,
    };
    const lines = createReadFileEvidenceRef(linesFact, linesAttachment);
    assert.equal(lines?.kind, "file_lines");
    if (lines?.kind !== "file_lines") return;
    assert.deepEqual(
      { startLine: lines.startLine, endLine: lines.endLine, byteRange: lines.byteRange },
      { startLine: 1, endLine: 2, byteRange: { start: 0, end: 8 } },
    );
  });

  it("does not invent evidence for an empty slice beyond EOF or a mismatched attachment", () => {
    const source = readTextSnapshot(Buffer.from("one\n", "utf8"), {
      startLine: 3,
      lineCount: 2,
    });
    assert.equal(source.ok, true);
    if (!source.ok) return;
    const fact = createReadFileFact(
      "snapshot-empty-slice",
      boundTextSnapshotForModel(source.value),
    );
    const attachment = {
      attachmentId: "attachment-1",
      sha256: fact.snapshot.fileSha256,
      byteLength: fact.snapshot.totalBytes,
      mediaKind: "text/plain" as const,
      publicationStatus: "published" as const,
    };
    assert.equal(createReadFileEvidenceRef(fact, attachment), null);
    assert.equal(
      createReadFileEvidenceRef(fact, {
        ...attachment,
        sha256: "0".repeat(64),
      }),
      null,
    );
  });
});
