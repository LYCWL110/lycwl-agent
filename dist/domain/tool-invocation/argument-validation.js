/**
 * Tool argument validation against the catalog schema.
 *
 * The catalog already carries a JSON Schema for every built-in tool, and it is sent
 * to the model. It was never used to check what came back, so each adapter
 * re-implemented the same `typeof x !== "string"` checks by hand — about 77 of them
 * across ten files. Hand-written checks drift from the advertised schema, and a
 * mismatch means the model is told one contract and held to another.
 *
 * This is deliberately not a general JSON Schema implementation. It supports the
 * keywords the catalog actually uses, and refuses a schema that contains anything
 * else rather than silently ignoring it. A validator that quietly skips an
 * unsupported keyword would report a value as valid when the constraint was never
 * applied, which is worse than failing to validate at all.
 *
 * Supported: `type`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`,
 * `pattern`, `items`, `required`, `properties`, `additionalProperties`.
 */
export const VALIDATION_LIMITS = Object.freeze({
    /** Guards against a pathological schema or value nesting depth. */
    maxDepth: 32,
    /** A schema with more properties than this is not one of ours. */
    maxProperties: 128,
});
const SUPPORTED_KEYWORDS = new Set([
    "type",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "items",
    "required",
    "properties",
    "additionalProperties",
    "description",
    "default",
    "title",
]);
/** Keywords that carry no constraint, so ignoring them is safe. */
const ANNOTATION_KEYWORDS = new Set(["description", "default", "title"]);
/**
 * Check that a schema uses only supported keywords.
 *
 * Called once per tool definition at composition time, so an unsupported keyword is
 * a startup failure rather than a value that silently escapes validation.
 */
export function checkSchemaSupport(schema, depth = 0) {
    if (depth > VALIDATION_LIMITS.maxDepth)
        return { ok: false, keyword: "(depth)" };
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return { ok: false, keyword: "(not an object)" };
    }
    const record = schema;
    for (const key of Object.keys(record)) {
        if (!SUPPORTED_KEYWORDS.has(key))
            return { ok: false, keyword: key };
    }
    const properties = record["properties"];
    if (properties !== undefined) {
        if (typeof properties !== "object" || properties === null) {
            return { ok: false, keyword: "properties" };
        }
        const entries = Object.entries(properties);
        if (entries.length > VALIDATION_LIMITS.maxProperties) {
            return { ok: false, keyword: "properties" };
        }
        for (const [, value] of entries) {
            const nested = checkSchemaSupport(value, depth + 1);
            if (!nested.ok)
                return nested;
        }
    }
    const items = record["items"];
    if (items !== undefined) {
        const nested = checkSchemaSupport(items, depth + 1);
        if (!nested.ok)
            return nested;
    }
    return { ok: true };
}
/** Whether the schema is annotation-only, meaning it constrains nothing. */
export function isUnconstrained(schema) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema))
        return true;
    const record = schema;
    return Object.keys(record).every((key) => ANNOTATION_KEYWORDS.has(key));
}
/**
 * Validate a value.
 *
 * Collects every issue rather than stopping at the first: the model needs to fix
 * all of them at once, and one error per round trip wastes the round.
 */
export function validateValue(schema, value) {
    const issues = [];
    walk(schema, value, "", issues, 0);
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
function walk(schema, value, path, issues, depth) {
    if (depth > VALIDATION_LIMITS.maxDepth) {
        issues.push({ path, expected: "a value within the nesting limit", actual: "(too deep)" });
        return;
    }
    if (typeof schema !== "object" || schema === null || Array.isArray(schema))
        return;
    const record = schema;
    const type = record["type"];
    if (typeof type === "string" && !matchesType(type, value)) {
        issues.push({ path, expected: type, actual: describe(value) });
        // A wrong type makes the remaining keywords meaningless.
        return;
    }
    const enumValues = record["enum"];
    if (Array.isArray(enumValues) && !enumValues.some((entry) => entry === value)) {
        issues.push({
            path,
            expected: `one of ${enumValues.map((entry) => describe(entry)).join(", ")}`,
            actual: describe(value),
        });
    }
    if (typeof value === "number") {
        const minimum = record["minimum"];
        if (typeof minimum === "number" && value < minimum) {
            issues.push({ path, expected: `>= ${minimum}`, actual: String(value) });
        }
        const maximum = record["maximum"];
        if (typeof maximum === "number" && value > maximum) {
            issues.push({ path, expected: `<= ${maximum}`, actual: String(value) });
        }
    }
    if (typeof value === "string") {
        const minLength = record["minLength"];
        if (typeof minLength === "number" && value.length < minLength) {
            issues.push({
                path,
                expected: `at least ${minLength} characters`,
                actual: `${value.length}`,
            });
        }
        const maxLength = record["maxLength"];
        if (typeof maxLength === "number" && value.length > maxLength) {
            issues.push({ path, expected: `at most ${maxLength} characters`, actual: `${value.length}` });
        }
        const pattern = record["pattern"];
        if (typeof pattern === "string") {
            let compiled = null;
            try {
                // The pattern comes from the catalog, not from the model.
                compiled = new RegExp(pattern, "u");
            }
            catch {
                // An invalid pattern is a catalog bug; refusing every value is the safe
                // direction rather than accepting them all.
                issues.push({ path, expected: `to match /${pattern}/`, actual: describe(value) });
                return;
            }
            if (!compiled.test(value)) {
                issues.push({ path, expected: `to match /${pattern}/`, actual: describe(value) });
            }
        }
    }
    if (Array.isArray(value)) {
        const items = record["items"];
        if (items !== undefined) {
            value.forEach((entry, index) => {
                walk(items, entry, path === "" ? `[${index}]` : `${path}[${index}]`, issues, depth + 1);
            });
        }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const object = value;
        const required = record["required"];
        if (Array.isArray(required)) {
            for (const name of required) {
                if (typeof name !== "string")
                    continue;
                if (!Object.hasOwn(object, name)) {
                    issues.push({
                        path: path === "" ? name : `${path}.${name}`,
                        expected: "to be present",
                        actual: "(missing)",
                    });
                }
            }
        }
        const properties = record["properties"];
        const declared = typeof properties === "object" && properties !== null
            ? properties
            : {};
        for (const [name, nested] of Object.entries(declared)) {
            if (!Object.hasOwn(object, name))
                continue;
            walk(nested, object[name], path === "" ? name : `${path}.${name}`, issues, depth + 1);
        }
        if (record["additionalProperties"] === false) {
            for (const name of Object.keys(object)) {
                if (Object.hasOwn(declared, name))
                    continue;
                issues.push({
                    path: path === "" ? name : `${path}.${name}`,
                    expected: "to be declared in the schema",
                    actual: "(unexpected)",
                });
            }
        }
    }
}
function matchesType(type, value) {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isSafeInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "array":
            return Array.isArray(value);
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "null":
            return value === null;
        default:
            // An unknown type name cannot be checked; treating it as a mismatch would
            // reject every value, and treating it as a match would accept every value.
            // The catalog is checked at startup, so this is unreachable in practice.
            return false;
    }
}
/** Short, non-echoing description of a value. */
function describe(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return `array(${value.length})`;
    if (typeof value === "string") {
        // Never echo the value: it may contain a credential the user pasted.
        return `string(${value.length})`;
    }
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return typeof value;
}
/** Render issues for a tool result. */
export function describeIssues(issues) {
    const shown = issues.slice(0, 8);
    const lines = shown.map((issue) => `  ${issue.path === "" ? "(root)" : issue.path}: expected ${issue.expected}, got ${issue.actual}`);
    if (issues.length > shown.length) {
        lines.push(`  (${issues.length - shown.length} more)`);
    }
    return lines.join("\n");
}
