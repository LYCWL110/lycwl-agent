import type { TextDelivery, TextDeliveryEvidence } from "./text-delivery.ts";

export type ReadFileSnapshot = TextDeliveryEvidence &
  Readonly<{
    snapshotId: string;
  }>;

export type ReadFileSlice =
  | Readonly<{
      kind: "empty";
      atLine: number;
    }>
  | Readonly<{
      kind: "lines";
      startLine: number;
      endLine: number;
      byteRange: Readonly<{ start: number; end: number }>;
      fullLines: boolean;
      deliveredByteRange: Readonly<{ start: number; end: number }>;
    }>;

export type ReadFileFact = Readonly<{
  snapshot: ReadFileSnapshot;
  slice: ReadFileSlice;
  content: string;
  textTruncated: boolean;
}>;

export type ReadFileAttachment = Readonly<{
  attachmentId: string;
  sha256: string;
  byteLength: number;
  mediaKind: "text/plain";
  publicationStatus: "published";
}>;

export type ReadFileEvidenceSummary = Readonly<{
  attachmentRefs: readonly ReadFileAttachment[];
  capturedBytes: number;
  rawComplete: boolean;
  rawTruncationReason: "capture_interrupted" | null;
  modelTextUnits: number;
  modelTextTruncated: boolean;
  modelTextTruncationReason: "model_budget" | null;
}>;

export type ReadFileEvidenceRef =
  | Readonly<{
      kind: "whole_file";
      snapshot: ReadFileSnapshot;
      attachment: ReadFileAttachment;
    }>
  | Readonly<{
      kind: "file_lines";
      snapshot: ReadFileSnapshot;
      attachment: ReadFileAttachment;
      startLine: number;
      endLine: number;
      byteRange: Readonly<{ start: number; end: number }>;
    }>;

export function createReadFileFact(
  snapshotId: string,
  delivery: TextDelivery,
): ReadFileFact {
  const snapshot = delivery.snapshot;
  const slice = createSlice(delivery);

  return {
    snapshot: {
      ...snapshot,
      snapshotId,
    },
    slice,
    content: delivery.text,
    textTruncated: delivery.modelTextTruncated,
  };
}

export function createReadFileEvidence(
  fact: ReadFileFact,
  attachment: ReadFileAttachment | null,
): ReadFileEvidenceSummary {
  const attachmentMatches = attachmentMatchesSnapshot(fact, attachment);

  return {
    attachmentRefs: attachmentMatches ? [attachment] : [],
    capturedBytes: fact.snapshot.totalBytes,
    rawComplete: attachmentMatches,
    rawTruncationReason: attachmentMatches ? null : "capture_interrupted",
    modelTextUnits: fact.content.length,
    modelTextTruncated: fact.textTruncated,
    modelTextTruncationReason: fact.textTruncated ? "model_budget" : null,
  };
}

export function createReadFileEvidenceRef(
  fact: ReadFileFact,
  attachment: ReadFileAttachment | null,
): ReadFileEvidenceRef | null {
  if (!attachmentMatchesSnapshot(fact, attachment)) return null;
  if (fact.snapshot.totalBytes === 0) {
    return {
      kind: "whole_file",
      snapshot: fact.snapshot,
      attachment,
    };
  }
  if (fact.slice.kind !== "lines") return null;

  return {
    kind: "file_lines",
    snapshot: fact.snapshot,
    attachment,
    startLine: fact.slice.startLine,
    endLine: fact.slice.endLine,
    byteRange: fact.slice.byteRange,
  };
}

function attachmentMatchesSnapshot(
  fact: ReadFileFact,
  attachment: ReadFileAttachment | null,
): attachment is ReadFileAttachment {
  return (
    attachment !== null &&
    attachment.sha256 === fact.snapshot.fileSha256 &&
    attachment.byteLength === fact.snapshot.totalBytes
  );
}

function createSlice(delivery: TextDelivery): ReadFileSlice {
  if (delivery.text.length === 0) {
    return { kind: "empty", atLine: delivery.snapshot.startLine };
  }

  const endLine =
    delivery.snapshot.endLineExclusive > delivery.snapshot.startLine
      ? delivery.snapshot.endLineExclusive - 1
      : delivery.snapshot.startLine;

  return {
    kind: "lines",
    startLine: delivery.snapshot.startLine,
    endLine,
    byteRange: {
      start: delivery.snapshot.byteStart,
      end: delivery.snapshot.byteEnd,
    },
    fullLines: !delivery.modelTextTruncated,
    deliveredByteRange: {
      start: delivery.deliveredByteRange.start,
      end: delivery.deliveredByteRange.end,
    },
  };
}
