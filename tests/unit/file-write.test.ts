import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { planCreateFile, planEditFile } from "../../src/services/files/file-write.ts";

describe("create_file planning", () => {
  it("defaults to UTF-8 without BOM and LF", () => {
    const result = planCreateFile({ content: "one\ntwo\n" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.encoding, "utf-8");
    assert.equal(result.value.bom, false);
    assert.equal(result.value.lineEnding, "lf");
    assert.deepEqual([...result.value.bytes], [...Buffer.from("one\ntwo\n", "utf8")]);
    assert.equal(result.value.byteLength, 8);
  });

  it("converts supplied CRLF content to the selected LF default", () => {
    const result = planCreateFile({ content: "one\r\ntwo" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.value.bytes], [...Buffer.from("one\ntwo", "utf8")]);
  });

  it("honours an explicit supported encoding and line ending", () => {
    const result = planCreateFile({
      content: "a\nb",
      encoding: "utf-16le",
      lineEnding: "crlf",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.encoding, "utf-16le");
    assert.equal(result.value.lineEnding, "crlf");
    assert.deepEqual([...result.value.bytes], [...Buffer.from("a\r\nb", "utf16le")]);
  });

  it("rejects the legacy preserve value instead of mapping it to LF", () => {
    assert.deepEqual(planCreateFile({ content: "x", lineEnding: "preserve" }), {
      ok: false,
      code: "preserve_rejected",
    });
  });

  it("rejects empty content and unsupported encodings", () => {
    assert.deepEqual(planCreateFile({ content: "" }), { ok: false, code: "empty_content" });
    assert.deepEqual(planCreateFile({ content: "x", encoding: "shift-jis" as never }), {
      ok: false,
      code: "unsupported_encoding",
    });
  });

  it("fails when a character cannot be represented", () => {
    assert.deepEqual(planCreateFile({ content: "\u65e5\u672c\u8a9e", encoding: "latin-1" }), {
      ok: false,
      code: "unrepresentable_character",
    });
  });
});

describe("edit_file planning", () => {
  const ORIGINAL = Buffer.from("alpha\r\nbeta\r\ngamma\r\n", "utf8");

  it("replaces a single unique match and preserves the original bytes elsewhere", () => {
    const result = planEditFile({
      originalBytes: ORIGINAL,
      encoding: "utf-8",
      bom: false,
      lineEnding: "crlf",
      oldText: "beta",
      newText: "BETA",
      replaceAll: false,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.replacedOccurrences, 1);
    assert.equal(Buffer.from(result.value.bytes).toString("utf8"), "alpha\r\nBETA\r\ngamma\r\n");
  });

  it("rejects an ambiguous non-replaceAll match", () => {
    const result = planEditFile({
      originalBytes: Buffer.from("dup\ndup\n", "utf8"),
      encoding: "utf-8",
      bom: false,
      lineEnding: "lf",
      oldText: "dup",
      newText: "x",
      replaceAll: false,
    });
    assert.deepEqual(result, { ok: false, code: "match_ambiguous" });
  });

  it("replaces every occurrence when replaceAll is set", () => {
    const result = planEditFile({
      originalBytes: Buffer.from("dup\ndup\n", "utf8"),
      encoding: "utf-8",
      bom: false,
      lineEnding: "lf",
      oldText: "dup",
      newText: "x",
      replaceAll: true,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.replacedOccurrences, 2);
    assert.equal(Buffer.from(result.value.bytes).toString("utf8"), "x\nx\n");
  });

  it("reports a missing match instead of writing", () => {
    assert.deepEqual(
      planEditFile({
        originalBytes: ORIGINAL,
        encoding: "utf-8",
        bom: false,
        lineEnding: "crlf",
        oldText: "absent",
        newText: "x",
        replaceAll: false,
      }),
      { ok: false, code: "match_not_found" },
    );
  });

  it("enforces a supplied expected occurrence count", () => {
    assert.deepEqual(
      planEditFile({
        originalBytes: Buffer.from("dup\ndup\n", "utf8"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        oldText: "dup",
        newText: "x",
        replaceAll: true,
        expectedOccurrences: 1,
      }),
      { ok: false, code: "expected_occurrences_mismatch" },
    );
  });

  it("preserves a UTF-16LE BOM and encoding", () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]);
    const result = planEditFile({
      originalBytes: withBom,
      encoding: "utf-16le",
      bom: true,
      lineEnding: "lf",
      oldText: "hi",
      newText: "hello",
      replaceAll: false,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.bom, true);
    assert.deepEqual([...result.value.bytes.slice(0, 2)], [0xff, 0xfe]);
    assert.equal(Buffer.from(result.value.bytes.slice(2)).toString("utf16le"), "hello\n");
  });

  it("requires an explicit inserted line ending for a mixed-ending file", () => {
    const mixed = Buffer.from("a\nb\r\nc", "utf8");
    const missing = planEditFile({
      originalBytes: mixed,
      encoding: "utf-8",
      bom: false,
      lineEnding: "mixed",
      oldText: "b",
      newText: "b\nmore",
      replaceAll: false,
    });
    assert.deepEqual(missing, { ok: false, code: "line_ending_ambiguous" });

    const chosen = planEditFile({
      originalBytes: mixed,
      encoding: "utf-8",
      bom: false,
      lineEnding: "mixed",
      oldText: "b",
      newText: "b\nmore",
      replaceAll: false,
      insertedLineEnding: "crlf",
    });
    assert.equal(chosen.ok, true);
    if (!chosen.ok) return;
    assert.equal(Buffer.from(chosen.value.bytes).toString("utf8"), "a\nb\r\nmore\r\nc");
  });

  it("fails when an edit introduces an unrepresentable character", () => {
    assert.deepEqual(
      planEditFile({
        originalBytes: Buffer.from([0x61, 0x62, 0x63]),
        encoding: "latin-1",
        bom: false,
        lineEnding: "none",
        oldText: "abc",
        newText: "\u65e5\u672c\u8a9e",
        replaceAll: false,
      }),
      { ok: false, code: "unrepresentable_character" },
    );
  });

  it("rejects an empty oldText", () => {
    assert.deepEqual(
      planEditFile({
        originalBytes: ORIGINAL,
        encoding: "utf-8",
        bom: false,
        lineEnding: "crlf",
        oldText: "",
        newText: "x",
        replaceAll: false,
      }),
      { ok: false, code: "invalid_arguments" },
    );
  });

  it("reports the old and new hashes for conflict detection", () => {
    const result = planEditFile({
      originalBytes: ORIGINAL,
      encoding: "utf-8",
      bom: false,
      lineEnding: "crlf",
      oldText: "beta",
      newText: "BETA",
      replaceAll: false,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.oldSha256, /^[0-9a-f]{64}$/);
    assert.match(result.value.newSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(result.value.oldSha256, result.value.newSha256);
  });
});
