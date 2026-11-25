import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_CATALOG } from "../../src/domain/tool-catalog/tool-catalog.ts";
import {
  checkSchemaSupport,
  describeIssues,
  isUnconstrained,
  validateValue,
} from "../../src/domain/tool-invocation/argument-validation.ts";

/**
 * Argument validation against the advertised schema.
 *
 * The rule these tests protect: the schema sent to the model and the schema enforced
 * on the reply must be the same one. A validator that silently skips an unsupported
 * keyword would report a value as valid when the constraint was never applied, so
 * an unsupported keyword is refused rather than ignored.
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("type checks", () => {
  it("accepts a matching type", () => {
    assert.deepEqual(validateValue(object({ a: { type: "string" } }), { a: "x" }), { ok: true });
  });

  it("rejects a wrong type and reports the path", () => {
    const result = validateValue(object({ a: { type: "string" } }), { a: 1 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.path, "a");
    assert.equal(result.issues[0]?.expected, "string");
  });

  it("distinguishes integer from number", () => {
    assert.equal(validateValue({ type: "integer" }, 1).ok, true);
    assert.equal(validateValue({ type: "integer" }, 1.5).ok, false);
    assert.equal(validateValue({ type: "number" }, 1.5).ok, true);
  });

  it("rejects NaN and Infinity for number", () => {
    // A non-finite number is not a value any tool can act on.
    assert.equal(validateValue({ type: "number" }, Number.NaN).ok, false);
    assert.equal(validateValue({ type: "number" }, Number.POSITIVE_INFINITY).ok, false);
  });

  it("rejects an array where an object is required", () => {
    assert.equal(validateValue({ type: "object" }, []).ok, false);
  });

  it("rejects null where an object is required", () => {
    assert.equal(validateValue({ type: "object" }, null).ok, false);
  });
});

describe("constraints", () => {
  it("enforces enum membership", () => {
    const schema = { type: "string", enum: ["a", "b"] };
    assert.equal(validateValue(schema, "a").ok, true);
    assert.equal(validateValue(schema, "c").ok, false);
  });

  it("enforces minimum and maximum", () => {
    const schema = { type: "integer", minimum: 1, maximum: 10 };
    assert.equal(validateValue(schema, 1).ok, true);
    assert.equal(validateValue(schema, 10).ok, true);
    assert.equal(validateValue(schema, 0).ok, false);
    assert.equal(validateValue(schema, 11).ok, false);
  });

  it("enforces minLength and maxLength", () => {
    const schema = { type: "string", minLength: 2, maxLength: 4 };
    assert.equal(validateValue(schema, "ab").ok, true);
    assert.equal(validateValue(schema, "a").ok, false);
    assert.equal(validateValue(schema, "abcde").ok, false);
  });

  it("enforces pattern", () => {
    const schema = { type: "string", pattern: "^[a-z]+$" };
    assert.equal(validateValue(schema, "abc").ok, true);
    assert.equal(validateValue(schema, "ABC").ok, false);
  });

  it("rejects every value when the pattern itself is invalid", () => {
    // A broken pattern is a catalog bug; accepting everything would hide it.
    assert.equal(validateValue({ type: "string", pattern: "[" }, "x").ok, false);
  });

  it("enforces required", () => {
    const result = validateValue(object({ a: { type: "string" } }, ["a"]), {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.actual, "(missing)");
  });

  it("enforces additionalProperties false", () => {
    const result = validateValue(object({ a: { type: "string" } }), { a: "x", b: "y" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.path, "b");
  });

  it("validates array items", () => {
    const schema = { type: "array", items: { type: "string" } };
    assert.equal(validateValue(schema, ["a", "b"]).ok, true);
    const result = validateValue(schema, ["a", 1]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.path, "[1]");
  });

  it("reports nested object paths", () => {
    const schema = object({
      outer: object({ inner: { type: "integer" } }),
    });
    const result = validateValue(schema, { outer: { inner: "x" } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.path, "outer.inner");
  });

  it("collects every issue rather than stopping at the first", () => {
    // One error per round trip wastes the round; the model needs all of them.
    const schema = object({ a: { type: "string" }, b: { type: "integer" } });
    const result = validateValue(schema, { a: 1, b: "x" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues.length, 2);
  });

  it("does not echo a long string value", () => {
    // The value may contain a credential the user pasted.
    const secret = "s".repeat(200);
    const result = validateValue({ type: "integer" }, secret);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.actual, `string(${secret.length})`);
    assert.equal(result.issues[0]?.actual.includes(secret), false);
  });
});

describe("checkSchemaSupport", () => {
  it("accepts the keywords the catalog uses", () => {
    assert.deepEqual(checkSchemaSupport(object({ a: { type: "string", pattern: "^x$" } }, ["a"])), {
      ok: true,
    });
  });

  it("refuses an unsupported keyword", () => {
    // Ignoring it would advertise a constraint that is never applied.
    const support = checkSchemaSupport({ type: "string", oneOf: [{ type: "string" }] });
    assert.equal(support.ok, false);
    if (support.ok) return;
    assert.equal(support.keyword, "oneOf");
  });

  it("checks nested schemas", () => {
    const support = checkSchemaSupport(
      object({ a: { type: "array", items: { type: "string", format: "uuid" } } }),
    );
    assert.equal(support.ok, false);
    if (support.ok) return;
    assert.equal(support.keyword, "format");
  });

  it("accepts an annotation-only schema", () => {
    assert.deepEqual(checkSchemaSupport({ description: "anything" }), { ok: true });
  });
});

describe("isUnconstrained", () => {
  it("treats annotation-only as unconstrained", () => {
    assert.equal(isUnconstrained({ description: "x" }), true);
  });

  it("treats a typed schema as constrained", () => {
    assert.equal(isUnconstrained({ type: "string" }), false);
  });
});

describe("the real catalog", () => {
  it("uses only supported keywords", () => {
    // This is the startup check, run against the actual catalog.
    for (const entry of TOOL_CATALOG) {
      const support = checkSchemaSupport(entry.inputSchema);
      assert.equal(support.ok, true, `${entry.name}: ${support.ok ? "" : support.keyword}`);
    }
  });

  it("rejects a non-object argument for every tool", () => {
    for (const entry of TOOL_CATALOG) {
      assert.equal(validateValue(entry.inputSchema, "not an object").ok, false, entry.name);
    }
  });

  it("rejects a missing required field for every tool that declares one", () => {
    for (const entry of TOOL_CATALOG) {
      const required = entry.inputSchema.required;
      if (!Array.isArray(required) || required.length === 0) continue;
      assert.equal(validateValue(entry.inputSchema, {}).ok, false, entry.name);
    }
  });

  it("accepts a well-formed call for every tool", () => {
    // Built from each schema's own required fields, so this stays correct as the
    // catalog changes rather than hard-coding one example per tool.
    for (const entry of TOOL_CATALOG) {
      const required = entry.inputSchema.required;
      const properties = entry.inputSchema.properties;
      const args: Record<string, unknown> = {};
      for (const name of Array.isArray(required) ? required : []) {
        const spec = (properties as Record<string, Record<string, unknown>>)[name as string];
        args[name as string] = sampleFor(spec);
      }
      const result = validateValue(entry.inputSchema, args);
      assert.equal(
        result.ok,
        true,
        `${entry.name}: ${result.ok ? "" : describeIssues(result.issues)}`,
      );
    }
  });
});

/** A value that satisfies a property schema, for building a positive example. */
function sampleFor(spec: Record<string, unknown> | undefined): unknown {
  if (spec === undefined) return "x";
  const enumValues = spec["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const type = spec["type"];
  if (type === "integer" || type === "number") {
    const minimum = typeof spec["minimum"] === "number" ? spec["minimum"] : 1;
    return minimum;
  }
  if (type === "boolean") return true;
  if (type === "array") {
    const items = spec["items"];
    return items === undefined ? [] : [sampleFor(items as Record<string, unknown>)];
  }
  if (type === "object") {
    const required = spec["required"];
    const properties = spec["properties"];
    if (Array.isArray(required) && typeof properties === "object" && properties !== null) {
      const sample: Record<string, unknown> = {};
      for (const name of required) {
        if (typeof name !== "string") continue;
        sample[name] = sampleFor(
          (properties as Record<string, unknown>)[name] as Record<string, unknown> | undefined,
        );
      }
      return sample;
    }
    return {};
  }
  const pattern = spec["pattern"];
  if (typeof pattern === "string" && pattern.includes("[a-z]")) return "abc";
  return "x";
}
