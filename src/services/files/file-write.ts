import { createHash } from "node:crypto";

import type { TextFileEncoding, TextLineEndings } from "./text-snapshot.ts";

/**
 * File write planning (V1_BEHAVIOR_CONTRACTS section 3.1). New files default to
 * UTF-8 without BOM and LF. Editing an existing file preserves its supported
 * encoding, BOM and untouched bytes. Ambiguous mixed-ending insertions require
 * an explicit choice, and unrepresentable characters fail rather than being
 * silently replaced.
 */
export const NEW_FILE_ENCODING: TextFileEncoding = "utf-8";
export const NEW_FILE_LINE_ENDING = "lf" as const;

export type LineEndingChoice = "lf" | "crlf" | "cr";

export type FileWriteFailure =
  | "invalid_arguments"
  | "empty_content"
  | "content_too_large"
  | "line_ending_ambiguous"
  | "unrepresentable_character"
  | "unsupported_encoding"
  | "preserve_rejected"
  | "not_found"
  | "match_not_found"
  | "match_ambiguous"
  | "expected_occurrences_mismatch";

export type CreateFilePlan = Readonly<{
  kind: "create_file";
  encoding: TextFileEncoding;
  bom: boolean;
  lineEnding: LineEndingChoice;
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}>;

export type CreateFileRequest = Readonly<{
  content: string;
  encoding?: TextFileEncoding;
  lineEnding?: LineEndingChoice | "preserve";
}>;

export type CreateFileResult =
  | Readonly<{ ok: true; value: CreateFilePlan }>
  | Readonly<{ ok: false; code: FileWriteFailure }>;

const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_ENCODINGS: ReadonlySet<string> = new Set([
  "utf-8",
  "utf-16le",
  "utf-16be",
  "latin-1",
]);

export function planCreateFile(request: CreateFileRequest): CreateFileResult {
  const encoding = request.encoding ?? NEW_FILE_ENCODING;
  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    return { ok: false, code: "unsupported_encoding" };
  }
  // ADR-0022 explicitly rejects the legacy new-file preserve value; it is not
  // silently mapped to LF.
  if (request.lineEnding === "preserve") {
    return { ok: false, code: "preserve_rejected" };
  }
  const lineEnding = request.lineEnding ?? NEW_FILE_LINE_ENDING;

  if (typeof request.content !== "string") return { ok: false, code: "invalid_arguments" };
  if (request.content.length === 0) return { ok: false, code: "empty_content" };

  const normalized = normalizeLineEndings(request.content, endingText(lineEnding));
  const encoded = encodeText(normalized, encoding, false);
  if (encoded === null) return { ok: false, code: "unrepresentable_character" };
  if (encoded.bytes.byteLength > MAX_WRITE_BYTES) {
    return { ok: false, code: "content_too_large" };
  }

  return {
    ok: true,
    value: {
      kind: "create_file",
      encoding,
      bom: false,
      lineEnding,
      bytes: encoded.bytes,
      sha256: sha256(encoded.bytes),
      byteLength: encoded.bytes.byteLength,
    },
  };
}

export type EditFilePlan = Readonly<{
  kind: "edit_file";
  encoding: TextFileEncoding;
  bom: boolean;
  lineEnding: TextLineEndings;
  oldSha256: string;
  newSha256: string;
  replacedOccurrences: number;
  bytes: Uint8Array;
  byteLength: number;
}>;

export type EditFileRequest = Readonly<{
  originalBytes: Uint8Array;
  encoding: TextFileEncoding;
  bom: boolean;
  lineEnding: TextLineEndings;
  oldText: string;
  newText: string;
  replaceAll: boolean;
  expectedOccurrences?: number;
  /** Required when the file mixes line endings and new text adds lines. */
  insertedLineEnding?: LineEndingChoice;
}>;

export type EditFileResult =
  | Readonly<{ ok: true; value: EditFilePlan }>
  | Readonly<{ ok: false; code: FileWriteFailure }>;

export function planEditFile(request: EditFileRequest): EditFileResult {
  if (!SUPPORTED_ENCODINGS.has(request.encoding)) {
    return { ok: false, code: "unsupported_encoding" };
  }
  if (request.oldText.length === 0) return { ok: false, code: "invalid_arguments" };

  const original = decodeText(request.originalBytes, request.encoding, request.bom);
  if (original === null) return { ok: false, code: "invalid_arguments" };

  const occurrences = countOccurrences(original, request.oldText);
  if (occurrences === 0) return { ok: false, code: "match_not_found" };
  if (!request.replaceAll && occurrences !== 1) return { ok: false, code: "match_ambiguous" };
  if (request.expectedOccurrences !== undefined) {
    if (request.expectedOccurrences !== occurrences) {
      return { ok: false, code: "expected_occurrences_mismatch" };
    }
  }

  const addsLines = /[\r\n]/.test(request.newText);
  let insertedEnding: string | null = null;
  if (addsLines && request.lineEnding === "mixed") {
    if (request.insertedLineEnding === undefined) {
      return { ok: false, code: "line_ending_ambiguous" };
    }
    insertedEnding = endingText(request.insertedLineEnding);
  }

  const replacement =
    insertedEnding === null
      ? request.newText
      : normalizeLineEndings(request.newText, insertedEnding);

  const updated = request.replaceAll
    ? original.split(request.oldText).join(replacement)
    : replaceFirst(original, request.oldText, replacement);

  const encoded = encodeText(updated, request.encoding, request.bom);
  if (encoded === null) return { ok: false, code: "unrepresentable_character" };
  if (encoded.bytes.byteLength > MAX_WRITE_BYTES) {
    return { ok: false, code: "content_too_large" };
  }

  return {
    ok: true,
    value: {
      kind: "edit_file",
      encoding: request.encoding,
      bom: request.bom,
      lineEnding: request.lineEnding,
      oldSha256: sha256(request.originalBytes),
      newSha256: sha256(encoded.bytes),
      replacedOccurrences: request.replaceAll ? occurrences : 1,
      bytes: encoded.bytes,
      byteLength: encoded.bytes.byteLength,
    },
  };
}

function normalizeLineEndings(content: string, ending: string): string {
  return content.replace(/\r\n|\r|\n/g, ending);
}
function endingText(ending: LineEndingChoice): string {
  return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function encodeText(
  text: string,
  encoding: TextFileEncoding,
  bom: boolean,
): { bytes: Uint8Array } | null {
  if (encoding === "latin-1") {
    const bytes = new Uint8Array(text.length + (bom ? 0 : 0));
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code > 0xff) return null;
      bytes[index] = code;
    }
    return { bytes };
  }
  if (encoding === "utf-8") {
    const body = Buffer.from(text, "utf8");
    if (bom) return { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) };
    return { bytes: body };
  }
  if (encoding === "utf-16le") {
    const body = Buffer.from(text, "utf16le");
    if (bom) return { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), body]) };
    return { bytes: body };
  }
  // utf-16be: swap the UTF-16LE byte pairs.
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    be[index] = le[index + 1] ?? 0;
    be[index + 1] = le[index] ?? 0;
  }
  if (bom) return { bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), be]) };
  return { bytes: be };
}

function decodeText(bytes: Uint8Array, encoding: TextFileEncoding, bom: boolean): string | null {
  const body = bom ? bytes.subarray(bomLength(encoding)) : bytes;
  try {
    if (encoding === "latin-1") {
      let text = "";
      for (const byte of body) text += String.fromCharCode(byte);
      return text;
    }
    if (encoding === "utf-8") return new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (encoding === "utf-16le") {
      return new TextDecoder("utf-16le", { fatal: true }).decode(body);
    }
    const swapped = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 2) {
      swapped[index] = body[index + 1] ?? 0;
      swapped[index + 1] = body[index] ?? 0;
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
  } catch {
    return null;
  }
}

function bomLength(encoding: TextFileEncoding): number {
  return encoding === "utf-8" ? 3 : 2;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
