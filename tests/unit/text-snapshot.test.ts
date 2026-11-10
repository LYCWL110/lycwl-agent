import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { readTextSnapshot } from "../../src/services/files/text-snapshot.ts";

describe("text snapshot reads", () => {
  it("classifies homogeneous and absent line endings", () => {
    const lf = readTextSnapshot(Buffer.from("one\ntwo\n", "utf8"));
    assert.equal(lf.ok, true);
    if (!lf.ok) return;
    assert.equal(lf.value.lineEndings, "lf");

    const crlf = readTextSnapshot(Buffer.from("one\r\ntwo", "utf8"));
    assert.equal(crlf.ok, true);
    if (!crlf.ok) return;
    assert.equal(crlf.value.lineEndings, "crlf");

    const cr = readTextSnapshot(Buffer.from("one\rtwo\r", "utf8"));
    assert.equal(cr.ok, true);
    if (!cr.ok) return;
    assert.equal(cr.value.lineEndings, "cr");

    const none = readTextSnapshot(Buffer.from("one", "utf8"));
    assert.equal(none.ok, true);
    if (!none.ok) return;
    assert.equal(none.value.lineEndings, "none");
  });

  it("reads the default 1-based line range without fabricating a final line", () => {
    const result = readTextSnapshot(Buffer.from("one\r\ntwo\nthree", "utf8"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.totalLines, 3);
    assert.equal(result.value.lineEndings, "mixed");
    assert.equal(result.value.startLine, 1);
    assert.equal(result.value.endLineExclusive, 4);
    assert.deepEqual(result.value.content, "one\r\ntwo\nthree");
    assert.equal(result.value.byteStart, 0);
    assert.equal(result.value.byteEnd, 14);
  });

  it("treats CR, LF, and CRLF as one newline each and includes terminators in ranges", () => {
    const bytes = Buffer.from("a\r\nb\rc\n", "utf8");
    const result = readTextSnapshot(bytes, { startLine: 2, lineCount: 2 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.content, "b\rc\n");
    assert.equal(result.value.lineEndings, "mixed");
    assert.equal(result.value.startLine, 2);
    assert.equal(result.value.endLineExclusive, 4);
    assert.equal(result.value.byteStart, 3);
    assert.equal(result.value.byteEnd, 7);
  });

  it("returns an empty slice beyond EOF without changing line numbers", () => {
    const result = readTextSnapshot(Buffer.from("one\n", "utf8"), {
      startLine: 3,
      lineCount: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.content, "");
    assert.equal(result.value.totalLines, 1);
    assert.equal(result.value.lineEndings, "lf");
    assert.equal(result.value.startLine, 3);
    assert.equal(result.value.endLineExclusive, 3);
    assert.equal(result.value.byteStart, 4);
    assert.equal(result.value.byteEnd, 4);
  });

  it("detects UTF-8 and UTF-16 BOMs and preserves Unicode text", () => {
    const utf8 = readTextSnapshot(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文", "utf8")]),
    );
    assert.equal(utf8.ok, true);
    if (!utf8.ok) return;
    assert.equal(utf8.value.encoding, "utf-8");
    assert.equal(utf8.value.bom, "utf-8");
    assert.equal(utf8.value.content, "中文");
    assert.equal(utf8.value.lineEndings, "none");

    const utf16 = readTextSnapshot(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf16le")]),
    );
    assert.equal(utf16.ok, true);
    if (!utf16.ok) return;
    assert.equal(utf16.value.encoding, "utf-16le");
    assert.equal(utf16.value.content, "中文");
    assert.equal(utf16.value.totalBytes, 6);
  });

  it("rejects malformed input, NUL bytes, encoding mismatches, and oversized files", () => {
    assert.deepEqual(readTextSnapshot(Buffer.from([0xff]), { encoding: "utf-8" }), {
      ok: false,
      code: "decoding_failed",
    });
    assert.deepEqual(readTextSnapshot(Buffer.from("a\0b", "utf8")), {
      ok: false,
      code: "binary_content",
    });
    assert.deepEqual(
      readTextSnapshot(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a", "utf16le")]), {
        encoding: "utf-8",
      }),
      { ok: false, code: "encoding_mismatch" },
    );
    assert.deepEqual(readTextSnapshot(Buffer.alloc(5 * 1024 * 1024 + 1)), {
      ok: false,
      code: "file_too_large",
    });
    assert.deepEqual(readTextSnapshot(Buffer.from("a"), { startLine: 0 }), {
      ok: false,
      code: "invalid_line_range",
    });
    assert.deepEqual(readTextSnapshot(Buffer.from("a"), { lineCount: 2001 }), {
      ok: false,
      code: "invalid_line_range",
    });
  });

  it("computes SHA-256 over the complete raw snapshot", () => {
    const bytes = Buffer.from("stable\n", "utf8");
    const result = readTextSnapshot(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.value.fileSha256,
      "2b92ea252be0fbc26f70317cdaa7b6411ea634b50d55338cd8c495e4dbf25d1d",
    );
  });

  it("supports explicit UTF-16BE and Latin-1 input", () => {
    const utf16be = readTextSnapshot(Buffer.from([0x00, 0x41]), {
      encoding: "utf-16be",
    });
    assert.equal(utf16be.ok, true);
    if (!utf16be.ok) return;
    assert.equal(utf16be.value.content, "A");
    assert.equal(utf16be.value.byteEnd, 2);

    const latin1 = readTextSnapshot(Buffer.from([0xe9]), { encoding: "latin-1" });
    assert.equal(latin1.ok, true);
    if (!latin1.ok) return;
    assert.equal(latin1.value.content, "é");
    assert.equal(latin1.value.lineEndings, "none");
    assert.equal(latin1.value.byteEnd, 1);
  });

  it("maps UTF-8, UTF-16LE, and UTF-16BE lines to exact original byte ranges", () => {
    const utf8 = readTextSnapshot(Buffer.from("😀\nnext", "utf8"), {
      startLine: 1,
      lineCount: 1,
    });
    assert.equal(utf8.ok, true);
    if (!utf8.ok) return;
    assert.equal(utf8.value.content, "😀\n");
    assert.deepEqual(
      { start: utf8.value.byteStart, end: utf8.value.byteEnd },
      { start: 0, end: 5 },
    );

    const utf16leBytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("😀\nnext", "utf16le"),
    ]);
    const utf16le = readTextSnapshot(utf16leBytes, { startLine: 1, lineCount: 1 });
    assert.equal(utf16le.ok, true);
    if (!utf16le.ok) return;
    assert.equal(utf16le.value.content, "😀\n");
    assert.deepEqual(
      { start: utf16le.value.byteStart, end: utf16le.value.byteEnd },
      { start: 2, end: 8 },
    );
    assert.equal(
      utf16leBytes.subarray(utf16le.value.byteStart, utf16le.value.byteEnd).toString("utf16le"),
      "😀\n",
    );

    const utf16beBytes = Buffer.from([0xd8, 0x3d, 0xde, 0x00, 0x00, 0x0a, 0x00, 0x6e]);
    const utf16be = readTextSnapshot(utf16beBytes, {
      encoding: "utf-16be",
      startLine: 1,
      lineCount: 1,
    });
    assert.equal(utf16be.ok, true);
    if (!utf16be.ok) return;
    assert.equal(utf16be.value.content, "😀\n");
    assert.deepEqual(
      { start: utf16be.value.byteStart, end: utf16be.value.byteEnd },
      { start: 0, end: 6 },
    );
  });
});
