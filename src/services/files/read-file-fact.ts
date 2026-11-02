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
