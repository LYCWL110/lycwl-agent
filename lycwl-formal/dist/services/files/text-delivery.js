const MAX_MODEL_TEXT_UNITS = 20_000;
export function boundTextSnapshotForModel(snapshot) {
    const evidence = {
        fileSha256: snapshot.fileSha256,
        encoding: snapshot.encoding,
        bom: snapshot.bom,
        totalBytes: snapshot.totalBytes,
        totalLines: snapshot.totalLines,
        lineEndings: snapshot.lineEndings,
        startLine: snapshot.startLine,
        endLineExclusive: snapshot.endLineExclusive,
        byteStart: snapshot.byteStart,
        byteEnd: snapshot.byteEnd,
    };
    if (snapshot.content.length <= MAX_MODEL_TEXT_UNITS) {
        return {
            text: snapshot.content,
            modelTextUnits: snapshot.content.length,
            modelTextTruncated: false,
            modelTextTruncationReason: null,
            deliveredByteRange: {
                start: snapshot.byteStart,
                end: snapshot.byteEnd,
            },
            snapshot: evidence,
        };
    }
    let end = MAX_MODEL_TEXT_UNITS;
    const lastUnit = snapshot.content.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff)
        end -= 1;
    if (snapshot.content.charCodeAt(end - 1) === 0x0d && snapshot.content.charCodeAt(end) === 0x0a) {
        end -= 1;
    }
    const text = snapshot.content.slice(0, end);
    return {
        text,
        modelTextUnits: text.length,
        modelTextTruncated: true,
        modelTextTruncationReason: "model_budget",
        deliveredByteRange: {
            start: snapshot.byteStart,
            end: snapshot.byteStart + encodedPrefixLength(text, snapshot.encoding),
        },
        snapshot: evidence,
    };
}
function encodedPrefixLength(text, encoding) {
    if (encoding === "utf-16le" || encoding === "utf-16be")
        return text.length * 2;
    if (encoding === "latin-1")
        return text.length;
    return new TextEncoder().encode(text).byteLength;
}
