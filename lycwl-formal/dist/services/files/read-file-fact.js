export function createReadFileFact(snapshotId, delivery) {
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
export function createReadFileEvidence(fact, attachment) {
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
export function createReadFileEvidenceRef(fact, attachment) {
    if (!attachmentMatchesSnapshot(fact, attachment))
        return null;
    if (fact.snapshot.totalBytes === 0) {
        return {
            kind: "whole_file",
            snapshot: fact.snapshot,
            attachment,
        };
    }
    if (fact.slice.kind !== "lines")
        return null;
    return {
        kind: "file_lines",
        snapshot: fact.snapshot,
        attachment,
        startLine: fact.slice.startLine,
        endLine: fact.slice.endLine,
        byteRange: fact.slice.byteRange,
    };
}
function attachmentMatchesSnapshot(fact, attachment) {
    return (attachment !== null &&
        attachment.sha256 === fact.snapshot.fileSha256 &&
        attachment.byteLength === fact.snapshot.totalBytes);
}
function createSlice(delivery) {
    if (delivery.text.length === 0) {
        return { kind: "empty", atLine: delivery.snapshot.startLine };
    }
    const endLine = delivery.snapshot.endLineExclusive > delivery.snapshot.startLine
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
