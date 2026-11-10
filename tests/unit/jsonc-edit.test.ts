import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import {
  insertTopLevelValue,
  removeTopLevelKey,
  replaceTopLevelValue,
  serializeScalar,
} from "../../src/domain/config/jsonc-edit.ts";

const SAMPLE = `{
  // keep this comment
  "schemaVersion": 1,
  "revision": 3,
  "theme": "dark" // trailing note
}
`;

function edited(result: ReturnType<typeof replaceTopLevelValue>): string {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.text;
}

/** Parse text that a test just edited; a parse failure means the edit was broken. */
function plain(text: string): unknown {
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new Error(`edited text no longer parses: ${parsed.error.message}`);
  return toPlainValue(parsed.value);
}

describe("localized JSONC replacement", () => {
  it("replaces one value and preserves comments and layout", () => {
    const text = edited(replaceTopLevelValue(SAMPLE, "theme", "light"));
    assert.match(text, /\/\/ keep this comment/);
    assert.match(text, /\/\/ trailing note/);
    assert.match(text, /"theme": "light"/);
    assert.deepEqual(plain(text), {
      schemaVersion: 1,
      revision: 3,
      theme: "light",
    });
    // Only the theme line changed; assert the untouched bytes survive verbatim.
    assert.match(text, /"schemaVersion": 1,/);
    assert.match(text, /"revision": 3,/);
  });

  it("replaces a number", () => {
    const withNumber = edited(replaceTopLevelValue(SAMPLE, "revision", 4));
    assert.match(withNumber, /"revision": 4/);
  });

  it("refuses an unknown key instead of appending", () => {
    const result = replaceTopLevelValue(SAMPLE, "absent", 1);
    assert.deepEqual(result, { ok: false, code: "unknown_key", detail: "absent" });
  });

  it("refuses an invalid document", () => {
    const result = replaceTopLevelValue("{oops", "a", 1);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_document");
  });

  it("refuses a non-object root", () => {
    const result = replaceTopLevelValue("[1,2]", "a", 1);
    assert.deepEqual(result, { ok: false, code: "root_not_object" });
  });
});

describe("localized JSONC insertion", () => {
  it("inserts into an empty object", () => {
    const text = edited(insertTopLevelValue("{}", "a", 1));
    assert.deepEqual(plain(text), { a: 1 });
  });

  it("appends after the last member and matches indentation", () => {
    const text = edited(insertTopLevelValue(SAMPLE, "model", "m1"));
    assert.equal((plain(text) as { model?: string }).model, "m1");
    // The inserted line uses the same two-space indent as its neighbours.
    assert.match(text, /\n {2}"model": "m1"/);
    // Existing comments survive.
    assert.match(text, /\/\/ keep this comment/);
    assert.match(text, /\/\/ trailing note/);
  });

  it("uses CRLF when the document uses CRLF", () => {
    const text = edited(insertTopLevelValue('{\r\n  "a": 1\r\n}\r\n', "b", 2));
    assert.match(text, /\r\n {2}"b": 2/);
  });

  it("refuses an existing key", () => {
    const result = insertTopLevelValue(SAMPLE, "theme", "x");
    assert.deepEqual(result, { ok: false, code: "duplicate_key", detail: "theme" });
  });

  it("refuses an invalid document", () => {
    const result = insertTopLevelValue("{oops", "a", 1);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_document");
  });

  it("refuses a non-serializable value", () => {
    const result = insertTopLevelValue("{}", "a", Number.NaN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unsupported_value");
  });
});

describe("localized JSONC removal", () => {
  it("removes a middle member with its trailing comma", () => {
    const text = edited(removeTopLevelKey(SAMPLE, "revision"));
    const value = plain(text) as Record<string, unknown>;
    assert.equal("revision" in value, false);
    assert.equal(value["theme"], "dark");
    assert.equal(value["schemaVersion"], 1);
    assert.match(text, /\/\/ keep this comment/);
  });

  it("removes the last member with its preceding comma", () => {
    const text = edited(removeTopLevelKey(SAMPLE, "theme"));
    assert.equal("theme" in (plain(text) as object), false);
  });

  it("removes the only member", () => {
    const text = edited(removeTopLevelKey('{"a": 1}', "a"));
    assert.deepEqual(plain(text), {});
  });

  it("refuses an unknown key", () => {
    const result = removeTopLevelKey(SAMPLE, "absent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unknown_key");
  });

  it("refuses an invalid document", () => {
    const result = removeTopLevelKey("{oops", "a");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_document");
  });
});

describe("scalar serialization", () => {
  it("serializes primitives", () => {
    assert.deepEqual(serializeScalar(null), { ok: true, text: "null" });
    assert.deepEqual(serializeScalar(true), { ok: true, text: "true" });
    assert.deepEqual(serializeScalar(1.5), { ok: true, text: "1.5" });
    assert.deepEqual(serializeScalar('a"b'), { ok: true, text: '"a\\"b"' });
  });

  it("refuses a non-finite number", () => {
    const result = serializeScalar(Number.POSITIVE_INFINITY);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unsupported_value");
  });
});
