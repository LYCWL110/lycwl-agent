import { findMember, parseJsonc } from "./jsonc.js";
/** Serialize a primitive as a JSON literal. Objects and arrays are rejected. */
export function serializeScalar(value) {
    if (value === null)
        return { ok: true, text: "null" };
    if (typeof value === "boolean")
        return { ok: true, text: value ? "true" : "false" };
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return { ok: false, code: "unsupported_value", detail: "non-finite number" };
        }
        return { ok: true, text: JSON.stringify(value) };
    }
    if (typeof value === "string")
        return { ok: true, text: JSON.stringify(value) };
    return { ok: false, code: "unsupported_value" };
}
/**
 * Replace the value of an existing top-level key, preserving everything around it.
 */
export function replaceTopLevelValue(text, key, value) {
    const parsed = parseJsonc(text);
    if (!parsed.ok) {
        return { ok: false, code: "invalid_document", detail: parsed.error.message };
    }
    if (parsed.value.kind !== "object")
        return { ok: false, code: "root_not_object" };
    const member = findMember(parsed.value, key);
    if (member === null)
        return { ok: false, code: "unknown_key", detail: key };
    const literal = serializeScalar(value);
    if (!literal.ok)
        return literal;
    const before = text.slice(0, member.value.start);
    const after = text.slice(member.value.end);
    return { ok: true, text: `${before}${literal.text}${after}` };
}
/**
 * Insert a top-level key when it is absent.
 *
 * Placement is chosen so the common shapes stay readable: into an empty object, on
 * its own line matching the existing indentation, or appended after the last
 * member with a comma added. Existing trivia is never rewritten.
 */
export function insertTopLevelValue(text, key, value) {
    const parsed = parseJsonc(text);
    if (!parsed.ok) {
        return { ok: false, code: "invalid_document", detail: parsed.error.message };
    }
    if (parsed.value.kind !== "object")
        return { ok: false, code: "root_not_object" };
    if (findMember(parsed.value, key) !== null) {
        return { ok: false, code: "duplicate_key", detail: key };
    }
    const literal = serializeScalar(value);
    if (!literal.ok)
        return literal;
    const root = parsed.value;
    const keyText = JSON.stringify(key);
    if (root.members.length === 0) {
        // `{}` possibly with inner trivia: put the member between the braces.
        const open = root.start + 1;
        const close = root.end - 1;
        const inner = text.slice(open, close);
        if (inner.trim().length === 0) {
            return {
                ok: true,
                text: `${text.slice(0, open)} ${keyText}: ${literal.text} ${text.slice(close)}`,
            };
        }
    }
    const last = root.members.at(-1);
    if (last === undefined) {
        // No members but non-trivial trivia; fall back to inserting after `{`.
        const open = root.start + 1;
        return {
            ok: true,
            text: `${text.slice(0, open)} ${keyText}: ${literal.text},${text.slice(open)}`,
        };
    }
    const indent = detectIndent(text, last.keyStart);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const insertAt = last.value.end;
    const addition = `,${newline}${indent}${keyText}: ${literal.text}`;
    return { ok: true, text: `${text.slice(0, insertAt)}${addition}${text.slice(insertAt)}` };
}
/**
 * Remove a top-level key and the comma that separated it.
 *
 * Only the member span and one adjacent comma are touched, so surrounding comments
 * and layout stay intact. Comments that belonged to the removed member are left in
 * place rather than guessed at.
 */
export function removeTopLevelKey(text, key) {
    const parsed = parseJsonc(text);
    if (!parsed.ok) {
        return { ok: false, code: "invalid_document", detail: parsed.error.message };
    }
    if (parsed.value.kind !== "object")
        return { ok: false, code: "root_not_object" };
    const root = parsed.value;
    const index = root.members.findIndex((member) => member.key === key);
    if (index === -1)
        return { ok: false, code: "unknown_key", detail: key };
    const member = root.members[index];
    if (member === undefined)
        return { ok: false, code: "unknown_key", detail: key };
    // Prefer removing the trailing comma; if this is the last member, remove the
    // preceding one instead so the object stays valid.
    const afterValue = skipWhitespace(text, member.value.end);
    if (text[afterValue] === ",") {
        return { ok: true, text: `${text.slice(0, member.keyStart)}${text.slice(afterValue + 1)}` };
    }
    if (index > 0) {
        const previous = root.members[index - 1];
        if (previous !== undefined) {
            const commaBefore = lastCommaBetween(text, previous.value.end, member.keyStart);
            if (commaBefore !== -1) {
                return { ok: true, text: `${text.slice(0, commaBefore)}${text.slice(member.value.end)}` };
            }
        }
    }
    return { ok: true, text: `${text.slice(0, member.keyStart)}${text.slice(member.value.end)}` };
}
function skipWhitespace(text, from) {
    let index = from;
    for (;;) {
        const character = text[index];
        if (character === " " || character === "\t" || character === "\r" || character === "\n") {
            index += 1;
            continue;
        }
        return index;
    }
}
function lastCommaBetween(text, from, to) {
    for (let index = to - 1; index >= from; index -= 1) {
        if (text[index] === ",")
            return index;
    }
    return -1;
}
/**
 * Infer the indentation of the line a member starts on, so an inserted key matches
 * its neighbours. Defaults to two spaces.
 */
function detectIndent(text, keyStart) {
    const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
    const prefix = text.slice(lineStart, keyStart);
    const whitespace = /^[ \t]*/.exec(prefix);
    return whitespace === null ? "  " : whitespace[0];
}
