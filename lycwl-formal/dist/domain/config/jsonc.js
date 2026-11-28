/**
 * JSONC parser with source positions (C09 / V1_BASELINE section 13).
 *
 * The project needs localized edits that preserve unrelated comments and
 * formatting. A `JSON.parse` round trip destroys both, and a dependency install is
 * separately authorized, so this is a small, explicit parser instead of a
 * third-party one.
 *
 * Supported: objects, arrays, strings, numbers, `true`/`false`/`null`, `//` and
 * `/* *\/` comments, trailing commas, and a UTF-8 BOM. Rejected: duplicate object
 * keys (last-writer-wins would hide a mistake), unterminated constructs, control
 * characters in strings, and anything after the root value other than trivia.
 *
 * Every value node records `start`/`end` byte-free character offsets into the
 * original text, which is what makes a localized edit possible.
 */
export function parseJsonc(text) {
    const parser = new Parser(text);
    try {
        const value = parser.parseDocument();
        return { ok: true, value };
    }
    catch (error) {
        if (error instanceof JsoncParseFailure) {
            return { ok: false, error: { message: error.message, offset: error.offset } };
        }
        throw error;
    }
}
/** Convert a parsed tree to a plain value. Used after validation, not for editing. */
export function toPlainValue(node) {
    switch (node.kind) {
        case "object": {
            const output = {};
            for (const member of node.members)
                output[member.key] = toPlainValue(member.value);
            return output;
        }
        case "array":
            return node.items.map(toPlainValue);
        case "string":
        case "number":
        case "boolean":
            return node.value;
        case "null":
            return null;
    }
}
/** Find a member by key at the top level of an object node. */
export function findMember(node, key) {
    if (node.kind !== "object")
        return null;
    return node.members.find((member) => member.key === key) ?? null;
}
class JsoncParseFailure extends Error {
    offset;
    constructor(message, offset) {
        super(message);
        this.offset = offset;
    }
}
class Parser {
    #text;
    #index = 0;
    constructor(text) {
        // A BOM is not valid JSON text but is common in Windows-authored files.
        this.#text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
    parseDocument() {
        this.#skipTrivia();
        if (this.#index >= this.#text.length) {
            throw new JsoncParseFailure("document is empty", this.#index);
        }
        const value = this.#parseValue();
        this.#skipTrivia();
        if (this.#index < this.#text.length) {
            throw new JsoncParseFailure("unexpected content after the root value", this.#index);
        }
        return value;
    }
    #parseValue() {
        this.#skipTrivia();
        const start = this.#index;
        const character = this.#text[this.#index];
        if (character === undefined) {
            throw new JsoncParseFailure("unexpected end of input", start);
        }
        if (character === "{")
            return this.#parseObject();
        if (character === "[")
            return this.#parseArray();
        if (character === '"')
            return this.#parseString();
        if (character === "-" || isDigit(character))
            return this.#parseNumber();
        if (this.#text.startsWith("true", this.#index)) {
            this.#index += 4;
            return { kind: "boolean", start, end: this.#index, value: true };
        }
        if (this.#text.startsWith("false", this.#index)) {
            this.#index += 5;
            return { kind: "boolean", start, end: this.#index, value: false };
        }
        if (this.#text.startsWith("null", this.#index)) {
            this.#index += 4;
            return { kind: "null", start, end: this.#index };
        }
        throw new JsoncParseFailure(`unexpected character ${JSON.stringify(character)}`, start);
    }
    #parseObject() {
        const start = this.#index;
        this.#index += 1; // `{`
        const members = [];
        const seen = new Set();
        for (;;) {
            this.#skipTrivia();
            const next = this.#text[this.#index];
            if (next === undefined)
                throw new JsoncParseFailure("unterminated object", start);
            if (next === "}") {
                this.#index += 1;
                return { kind: "object", start, end: this.#index, members };
            }
            if (next !== '"')
                throw new JsoncParseFailure("expected a quoted object key", this.#index);
            const keyStart = this.#index;
            const key = this.#parseString().value;
            const keyEnd = this.#index;
            if (seen.has(key)) {
                throw new JsoncParseFailure(`duplicate key ${JSON.stringify(key)}`, keyStart);
            }
            seen.add(key);
            this.#skipTrivia();
            if (this.#text[this.#index] !== ":") {
                throw new JsoncParseFailure("expected ':' after an object key", this.#index);
            }
            this.#index += 1;
            const value = this.#parseValue();
            members.push({ key, keyStart, keyEnd, value });
            this.#skipTrivia();
            const separator = this.#text[this.#index];
            if (separator === ",") {
                this.#index += 1;
                // Trailing comma: the loop head handles `}`.
                continue;
            }
            if (separator === "}") {
                this.#index += 1;
                return { kind: "object", start, end: this.#index, members };
            }
            throw new JsoncParseFailure("expected ',' or '}' in an object", this.#index);
        }
    }
    #parseArray() {
        const start = this.#index;
        this.#index += 1; // `[`
        const items = [];
        for (;;) {
            this.#skipTrivia();
            const next = this.#text[this.#index];
            if (next === undefined)
                throw new JsoncParseFailure("unterminated array", start);
            if (next === "]") {
                this.#index += 1;
                return { kind: "array", start, end: this.#index, items };
            }
            items.push(this.#parseValue());
            this.#skipTrivia();
            const separator = this.#text[this.#index];
            if (separator === ",") {
                this.#index += 1;
                continue;
            }
            if (separator === "]") {
                this.#index += 1;
                return { kind: "array", start, end: this.#index, items };
            }
            throw new JsoncParseFailure("expected ',' or ']' in an array", this.#index);
        }
    }
    #parseString() {
        const start = this.#index;
        this.#index += 1; // opening quote
        let value = "";
        for (;;) {
            const character = this.#text[this.#index];
            if (character === undefined) {
                throw new JsoncParseFailure("unterminated string", start);
            }
            if (character === '"') {
                this.#index += 1;
                return { kind: "string", start, end: this.#index, value };
            }
            if (character === "\\") {
                this.#index += 1;
                value += this.#parseEscape(start);
                continue;
            }
            const codePoint = character.codePointAt(0) ?? 0;
            if (codePoint < 0x20) {
                throw new JsoncParseFailure("raw control character in string", this.#index);
            }
            value += character;
            this.#index += 1;
        }
    }
    #parseEscape(stringStart) {
        const escapeChar = this.#text[this.#index];
        this.#index += 1;
        switch (escapeChar) {
            case '"':
                return '"';
            case "\\":
                return "\\";
            case "/":
                return "/";
            case "b":
                return "\b";
            case "f":
                return "\f";
            case "n":
                return "\n";
            case "r":
                return "\r";
            case "t":
                return "\t";
            case "u": {
                const hex = this.#text.slice(this.#index, this.#index + 4);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                    throw new JsoncParseFailure("invalid \\u escape", this.#index);
                }
                this.#index += 4;
                return String.fromCharCode(Number.parseInt(hex, 16));
            }
            default:
                throw new JsoncParseFailure(`invalid escape ${JSON.stringify(escapeChar ?? "")}`, stringStart);
        }
    }
    #parseNumber() {
        const start = this.#index;
        const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#text.slice(start));
        if (match === null || match[0].length === 0) {
            throw new JsoncParseFailure("invalid number", start);
        }
        const raw = match[0];
        this.#index += raw.length;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
            throw new JsoncParseFailure("number is out of range", start);
        }
        return { kind: "number", start, end: this.#index, value };
    }
    #skipTrivia() {
        for (;;) {
            const character = this.#text[this.#index];
            if (character === undefined)
                return;
            if (character === " " || character === "\t" || character === "\r" || character === "\n") {
                this.#index += 1;
                continue;
            }
            if (character === "/" && this.#text[this.#index + 1] === "/") {
                this.#index += 2;
                while (this.#index < this.#text.length) {
                    const next = this.#text[this.#index];
                    if (next === "\n")
                        break;
                    this.#index += 1;
                }
                continue;
            }
            if (character === "/" && this.#text[this.#index + 1] === "*") {
                const close = this.#text.indexOf("*/", this.#index + 2);
                if (close === -1) {
                    throw new JsoncParseFailure("unterminated block comment", this.#index);
                }
                this.#index = close + 2;
                continue;
            }
            return;
        }
    }
}
function isDigit(value) {
    return value >= "0" && value <= "9";
}
