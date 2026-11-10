import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findMember,
  type JsoncNode,
  parseJsonc,
  toPlainValue,
} from "../../src/domain/config/jsonc.ts";

function parse(text: string): JsoncNode {
  const result = parseJsonc(text);
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${result.error.message} at ${result.error.offset}`,
  );
  if (!result.ok) throw new Error("parse failed");
  return result.value;
}

function failure(text: string): string {
  const result = parseJsonc(text);
  assert.equal(result.ok, false, "expected a parse failure");
  if (result.ok) return "";
  return result.error.message;
}

describe("jsonc parsing", () => {
  it("parses objects, arrays and scalars", () => {
    const value = parse('{"a":1,"b":[true,false,null],"c":"x"}');
    assert.deepEqual(toPlainValue(value), { a: 1, b: [true, false, null], c: "x" });
  });

  it("ignores line and block comments", () => {
    const value = parse(`{
      // a leading comment
      "a": 1, /* inline */ "b": 2
    }`);
    assert.deepEqual(toPlainValue(value), { a: 1, b: 2 });
  });

  it("accepts trailing commas in objects and arrays", () => {
    assert.deepEqual(toPlainValue(parse('{"a":1,}')), { a: 1 });
    assert.deepEqual(toPlainValue(parse("[1,2,]")), [1, 2]);
  });

  it("strips a UTF-8 BOM", () => {
    assert.deepEqual(toPlainValue(parse('\uFEFF{"a":1}')), { a: 1 });
  });

  it("handles string escapes", () => {
    const value = parse('{"s":"a\\"b\\\\c\\n\\t\\u0041"}');
    assert.deepEqual(toPlainValue(value), { s: 'a"b\\c\n\tA' });
  });

  it("handles numbers including exponents and negatives", () => {
    assert.deepEqual(toPlainValue(parse("[-1,0,1.5,1e3,2.5e-2]")), [-1, 0, 1.5, 1000, 0.025]);
  });

  it("records spans that cover the exact value text", () => {
    const text = '{"a": [1, 2]}';
    const root = parse(text);
    const member = findMember(root, "a");
    assert.ok(member);
    if (!member) return;
    assert.equal(text.slice(member.value.start, member.value.end), "[1, 2]");
  });

  it("reports a duplicate key rather than taking the last one", () => {
    assert.match(failure('{"a":1,"a":2}'), /duplicate key/);
  });

  it("rejects an unterminated block comment", () => {
    assert.match(failure('{"a":1} /* open'), /unterminated block comment/);
  });

  it("rejects content after the root value", () => {
    assert.match(failure('{"a":1} {"b":2}'), /unexpected content/);
  });

  it("rejects an empty document", () => {
    assert.match(failure("   "), /empty/);
  });

  it("rejects a raw control character inside a string", () => {
    assert.match(failure('{"a":"x\u0001y"}'), /control character/);
  });

  it("rejects an invalid escape", () => {
    assert.match(failure('{"a":"\\q"}'), /invalid escape/);
  });

  it("rejects a bare key", () => {
    assert.match(failure("{a: 1}"), /quoted object key/);
  });

  it("rejects a missing colon", () => {
    assert.match(failure('{"a" 1}'), /expected ':'/);
  });

  it("reports the offset of the failure", () => {
    const result = parseJsonc('{"a": @}');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.offset, 6);
  });
});
