import { randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileSnapshotFacts } from "../../services/files/consistent-snapshot.ts";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.ts";
import type { PatchTargetSnapshot } from "../tools/patch-tool.ts";
import type { WriteTargetFacts } from "../tools/write-tools.ts";

/**
 * Real Windows write adapter for the Stage 2B slice.
 *
 * Writes are same-volume temporary file plus atomic rename. A cross-volume temp
 * would silently become copy+delete, so it is never used. A failed temp write
 * leaves the target untouched; only the rename is a visible mutation.
 *
 * This module performs no delete or rename of user targets beyond replacing the
 * file the planner already validated.
 */

export type WriteFailure =
  | "invalid_path"
  | "not_found"
  | "access_denied"
  | "locked"
  | "file_conflict"
  | "write_failed";

export type WriteResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: WriteFailure }>;

export function createWindowsWriteAdapter(options: Readonly<{ workspaceRoot: string }>) {
  const { workspaceRoot } = options;

  /** Facts for conflict detection: existence plus the current content hash. */
  async function inspectTarget(relativePath: string): Promise<WriteTargetFacts> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) throw new Error("invalid_path");

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(supplied.value.absolutePath);
    } catch (error) {
      if (isNotFound(error)) return { exists: false, sha256: null };
      throw new Error(mapWriteError(error));
    }

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(resolvedPath, { bigint: true });
    } catch (error) {
      if (isNotFound(error)) return { exists: false, sha256: null };
      throw new Error(mapWriteError(error));
    }
    if (!stats.isFile()) throw new Error("invalid_path");

    try {
      const bytes = await readFile(resolvedPath);
      const { createHash } = await import("node:crypto");
      return { exists: true, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      throw new Error(mapWriteError(error));
    }
  }

  async function readBytes(relativePath: string): Promise<Uint8Array> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) throw new Error("invalid_path");
    try {
      return await readFile(supplied.value.absolutePath);
    } catch (error) {
      throw new Error(mapWriteError(error));
    }
  }

  /** Snapshot shape used by apply_patch preflight. */
  async function inspectPatchTarget(relativePath: string): Promise<PatchTargetSnapshot> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) throw new Error("invalid_path");

    let bytes: Uint8Array;
    let sha256: string | null;
    try {
      bytes = await readFile(supplied.value.absolutePath);
      const { createHash } = await import("node:crypto");
      sha256 = createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (isNotFound(error)) {
        return {
          path: relativePath,
          exists: false,
          sha256: null,
          encoding: "utf-8",
          lineEnding: "lf",
          bytes: new Uint8Array(),
        };
      }
      throw new Error(mapWriteError(error));
    }
    const format = detectFormat(bytes);
    return {
      path: relativePath,
      exists: true,
      sha256,
      encoding: format.encoding,
      lineEnding: format.lineEnding,
      bytes,
    };
  }

  /**
   * Write finished bytes with a same-volume temp file and atomic rename.
   *
   * `expectedSha256` is the hash captured at planning time; a mismatch means the
   * target changed and nothing is written.
   */
  async function writeBytes(
    relativePath: string,
    bytes: Uint8Array,
    expectedSha256?: string | null,
  ): Promise<WriteResult> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) return { ok: false, code: "invalid_path" };
    if (!supplied.value.withinWorkspace) return { ok: false, code: "invalid_path" };

    const target = supplied.value.absolutePath;
    const directory = path.dirname(target);

    if (expectedSha256 !== undefined) {
      let current: string | null;
      try {
        current = (await inspectTarget(relativePath)).sha256;
      } catch {
        return { ok: false, code: "file_conflict" };
      }
      if (current !== expectedSha256) return { ok: false, code: "file_conflict" };
    }

    const tempPath = path.join(
      directory,
      `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
    );

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      return { ok: false, code: mapWriteError(error) };
    }

    try {
      await rename(tempPath, target);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      return { ok: false, code: mapWriteError(error) };
    }

    return { ok: true };
  }

  return { inspectTarget, inspectPatchTarget, readBytes, writeBytes };
}

export type WindowsWriteAdapter = ReturnType<typeof createWindowsWriteAdapter>;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function mapWriteError(error: unknown): WriteFailure {
  if (typeof error !== "object" || error === null) return "write_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return "write_failed";
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "access_denied";
    case "EBUSY":
    case "EEXIST":
      return "locked";
    case "ENOSPC":
      return "write_failed";
    default:
      return "write_failed";
  }
}

function detectFormat(bytes: Uint8Array): {
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  lineEnding: "none" | "lf" | "crlf" | "cr" | "mixed";
} {
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasUtf16Le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasUtf16Be = bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = hasUtf16Le ? "utf-16le" : hasUtf16Be ? "utf-16be" : "utf-8";
  const body = bytes.subarray(hasUtf8Bom ? 3 : hasUtf16Le || hasUtf16Be ? 2 : 0);
  const text = Buffer.from(body).toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  const lineEnding =
    kinds === 0 ? "none" : kinds > 1 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "cr";
  return { encoding, lineEnding };
}

export type { FileSnapshotFacts };
