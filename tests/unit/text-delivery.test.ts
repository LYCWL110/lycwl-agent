import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { boundTextSnapshotForModel } from "../../src/services/files/text-delivery.ts";
import { readTextSnapshot } from "../../src/services/files/text-snapshot.ts";

function snapshot(content: string) {
  const result = readTextSnapshot(Buffer.from(content, "utf8"));
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe("bounded text delivery", () => {
  it("returns text unchanged when it fits the model budget", () => {
    const source = snapshot("short text\n");
    const delivery = boundTextSnapshotForModel(source);
    assert.equal(delivery.text, "short text\n");
    assert.equal(delivery.modelTextUnits, 11);
    assert.equal(delivery.modelTextTruncated, false);
    assert.equal(delivery.modelTextTruncationReason, null);
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 11 });
    assert.deepEqual(delivery.snapshot, {
      fileSha256: source.fileSha256,
      encoding: "utf-8",
      bom: null,
      totalBytes: 11,
      totalLines: 1,
      lineEndings: "lf",
      startLine: 1,
      endLineExclusive: 2,
      byteStart: 0,
      byteEnd: 11,
    });
  });

  it("accepts exactly 20,000 UTF-16 units without truncation", () => {
    const content = "a".repeat(20_000);
    const delivery = boundTextSnapshotForModel(snapshot(content));
    assert.equal(delivery.text, content);
    assert.equal(delivery.modelTextUnits, 20_000);
    assert.equal(delivery.modelTextTruncated, false);
    assert.equal(delivery.modelTextTruncationReason, null);
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 20_000 });
    assert.equal(delivery.snapshot.totalBytes, 20_000);
    assert.equal(delivery.snapshot.byteEnd, 20_000);
  });

  it("truncates an oversized long line and reports the model budget reason", () => {
    const delivery = boundTextSnapshotForModel(snapshot("a".repeat(20_001)));
    assert.equal(delivery.text, "a".repeat(20_000));
    assert.equal(delivery.modelTextUnits, 20_000);
    assert.equal(delivery.modelTextTruncated, true);
    assert.equal(delivery.modelTextTruncationReason, "model_budget");
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 20_000 });
    assert.equal(delivery.snapshot.totalBytes, 20_001);
    assert.equal(delivery.snapshot.byteEnd, 20_001);
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    const delivery = boundTextSnapshotForModel(snapshot(`${"a".repeat(19_999)}😀tail`));
    assert.equal(delivery.modelTextUnits, 19_999);
    assert.equal(delivery.text, "a".repeat(19_999));
    assert.equal(delivery.modelTextTruncated, true);
    assert.equal(delivery.modelTextTruncationReason, "model_budget");
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 19_999 });
    assert.doesNotThrow(() => encodeURIComponent(delivery.text));
  });

  it("keeps a surrogate pair that exactly completes the budget", () => {
    const content = `${"a".repeat(19_998)}😀tail`;
    const delivery = boundTextSnapshotForModel(snapshot(content));
    assert.equal(delivery.text, `${"a".repeat(19_998)}😀`);
    assert.equal(delivery.modelTextUnits, 20_000);
    assert.equal(delivery.modelTextTruncated, true);
    assert.equal(delivery.modelTextTruncationReason, "model_budget");
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 20_002 });
  });

  it("does not split a CRLF terminator at the truncation boundary", () => {
    const content = `${"a".repeat(19_999)}\r\ntail`;
    const delivery = boundTextSnapshotForModel(snapshot(content));
    assert.equal(delivery.text, "a".repeat(19_999));
    assert.equal(delivery.modelTextUnits, 19_999);
    assert.equal(delivery.modelTextTruncated, true);
    assert.equal(delivery.modelTextTruncationReason, "model_budget");
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 19_999 });
  });

  it("measures UTF-16 units rather than Unicode code points or UTF-8 bytes", () => {
    const content = "中".repeat(20_000);
    const source = snapshot(content);
    const delivery = boundTextSnapshotForModel(source);
    assert.equal(source.totalBytes, 60_000);
    assert.equal(delivery.text, content);
    assert.equal(delivery.modelTextUnits, 20_000);
    assert.equal(delivery.modelTextTruncated, false);
    assert.deepEqual(delivery.deliveredByteRange, { start: 0, end: 60_000 });
  });
});
