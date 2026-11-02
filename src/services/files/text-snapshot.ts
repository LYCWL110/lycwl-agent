import { createHash } from "node:crypto";

export type TextFileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1";

export type TextSnapshotRequest = Readonly<{
  startLine?: number;
  lineCount?: number;
  encoding?: TextFileEncoding;
}>;

export type TextSnapshotFailure =
  | "file_too_large"
  | "invalid_line_range"
  | "encoding_mismatch"
  | "decoding_failed"
  | "binary_content";

export type TextSnapshot = Readonly<{
  encoding: TextFileEncoding;
  bom: TextFileEncoding | null;
  fileSha256: string;
  totalBytes: number;
  totalLines: number;
  startLine: number;
  endLineExclusive: number;
  byteStart: number;
  byteEnd: number;
  content: string;
}>;

export type TextSnapshotResult =
  | Readonly<{ ok: true; value: TextSnapshot }>
  | Readonly<{ ok: false; code: TextSnapshotFailure }>;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_LINE_COUNT = 200;
const MAX_LINE_COUNT = 2_000;

type LinePosition = Readonly<{
  start: number;
  end: number;
  terminatorEnd: number;
}>;

export function readTextSnapshot(
  bytes: Uint8Array,
  request: TextSnapshotRequest = {},
): TextSnapshotResult {
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, code: "file_too_large" };

  const startLine = request.startLine ?? 1;
  const lineCount = request.lineCount ?? DEFAULT_LINE_COUNT;
  if (
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    !Number.isSafeInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > MAX_LINE_COUNT
  ) {
    return { ok: false, code: "invalid_line_range" };
  }

  const detectedBom = detectBom(bytes);
  const requestedEncoding = request.encoding;
  if (requestedEncoding !== undefined && detectedBom !== null && detectedBom !== requestedEncoding) {
    return { ok: false, code: "encoding_mismatch" };
  }
  if (requestedEncoding === "latin-1" && detectedBom !== null) {
    return { ok: false, code: "encoding_mismatch" };
  }

  const encoding = requestedEncoding ?? detectedBom ?? "utf-8";
  const decoderLabel = encoding === "latin-1" ? "iso-8859-1" : encoding;
  let decoded: string;
  try {
    decoded = new TextDecoder(decoderLabel, { fatal: true }).decode(
      detectedBom === null ? bytes : bytes.subarray(bomLength(detectedBom)),
    );
  } catch {
    return { ok: false, code: "decoding_failed" };
  }
  if (decoded.includes("\0")) return { ok: false, code: "binary_content" };

  const lines = findLines(decoded);
  const fromIndex = startLine - 1;
  const toIndex = Math.min(fromIndex + lineCount, lines.length);
  const selected = fromIndex < lines.length ? lines.slice(fromIndex, toIndex) : [];
  const first = selected[0] ?? null;
  const last = selected.at(-1) ?? null;
  const byteStart =
    first === null ? bytes.byteLength : bomLength(detectedBom) + encodedLength(decoded.slice(0, first.start), encoding);
  const byteEnd =
    last === null
      ? bytes.byteLength
      : bomLength(detectedBom) + encodedLength(decoded.slice(0, last.terminatorEnd), encoding);

  return {
    ok: true,
    value: {
      encoding,
      bom: detectedBom,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      totalBytes: bytes.byteLength,
      totalLines: lines.length,
      startLine,
      endLineExclusive: fromIndex < lines.length ? toIndex + 1 : startLine,
      byteStart,
      byteEnd,
      content:
        selected.length === 0
          ? ""
          : decoded.slice(selected[0]?.start ?? 0, selected.at(-1)?.terminatorEnd ?? 0),
    },
  };
}

function detectBom(bytes: Uint8Array): TextFileEncoding | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

function bomLength(encoding: TextFileEncoding | null): number {
  if (encoding === "utf-8") return 3;
  if (encoding === "utf-16le" || encoding === "utf-16be") return 2;
  return 0;
}

function findLines(value: string): LinePosition[] {
  const lines: LinePosition[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r" || character === "\n") {
      const terminatorLength =
        character === "\r" && value[index + 1] === "\n" ? 2 : 1;
      lines.push({
        start,
        end: index,
        terminatorEnd: index + terminatorLength,
      });
      index += terminatorLength - 1;
      start = index + 1;
    }
  }
  if (start < value.length) lines.push({ start, end: value.length, terminatorEnd: value.length });
  return lines;
}

function encodedLength(value: string, encoding: TextFileEncoding): number {
  if (encoding === "utf-16le" || encoding === "utf-16be") return value.length * 2;
  if (encoding === "latin-1") {
    let length = 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0xff) length += 1;
      else length += 2;
    }
    return length;
  }
  return new TextEncoder().encode(value).byteLength;
}
