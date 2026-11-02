import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileSnapshotFacts } from "../../services/files/consistent-snapshot.ts";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.ts";
import type { SearchEntry } from "../tools/search-tools.ts";

/**
 * Real read-only directory enumeration and file reading for the search tools and
 * read_file. No write capability exists in this module.
 *
 * Reparse directories are listed but never traversed automatically, so a
 * junction cannot pull content from outside the workspace into a search.
 */
export type DirectoryReadFailure =
  | "invalid_path"
  | "not_found"
  | "access_denied"
  | "not_a_directory"
  | "read_failed";

export type DirectoryReadResult =
  | Readonly<{ ok: true; entries: readonly SearchEntry[] }>
  | Readonly<{ ok: false; code: DirectoryReadFailure }>;

export type FileReadResult =
  | Readonly<{
      ok: true;
      bytes: Uint8Array;
      snapshot: FileSnapshotFacts;
    }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_path"
        | "not_found"
        | "access_denied"
        | "locked"
        | "not_a_regular_file"
        | "symbolic_link"
        | "file_too_large"
        | "file_changed"
        | "read_failed";
    }>;

const MAX_READ_BYTES = 5 * 1024 * 1024;

export function createWindowsFileReader(options: Readonly<{ workspaceRoot: string }>) {
  const { workspaceRoot } = options;

  async function listDirectory(relativeDirectory: string): Promise<DirectoryReadResult> {
    // An empty path means the workspace root itself, matching the search tools.
    const requested = relativeDirectory.length === 0 ? "." : relativeDirectory;
    const supplied = resolveWorkspacePath(workspaceRoot, requested);
    if (!supplied.ok) return { ok: false, code: "invalid_path" };
    if (!supplied.value.withinWorkspace) return { ok: false, code: "invalid_path" };

    // Resolve reparse points first: a junction must not pull outside content in.
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(supplied.value.absolutePath);
    } catch (error) {
      return { ok: false, code: mapDirectoryError(error) };
    }
    const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
    if (!resolved.ok || !resolved.value.withinWorkspace) {
      return { ok: false, code: "invalid_path" };
    }

    let names: string[];
    try {
      names = await readdir(resolved.value.absolutePath);
    } catch (error) {
      return { ok: false, code: mapDirectoryError(error) };
    }

    const prefix = toPosixRelative(workspaceRoot, resolved.value.absolutePath);
    const entries: SearchEntry[] = [];
    for (const name of names) {
      const childPath = path.join(resolved.value.absolutePath, name);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(childPath, { bigint: true });
      } catch {
        // A child that vanished between readdir and lstat is simply omitted.
        continue;
      }
      // Reparse points are reported as directories but never traversed by
      // callers; the entry kind stays honest.
      const kind = stats.isDirectory() ? "directory" : "file";
      entries.push({ path: prefix.length === 0 ? name : `${prefix}/${name}`, kind });
    }
    return { ok: true, entries };
  }

  /**
   * Read one regular file with identity checks before and after, refusing links
   * and oversized targets. Reuses the same facts shape as the injected flow.
   */
  async function readFile(relativePath: string): Promise<FileReadResult> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) return { ok: false, code: "invalid_path" };

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(supplied.value.absolutePath);
    } catch (error) {
      return { ok: false, code: mapFileReadError(error) };
    }
    const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
    if (!resolved.ok) return { ok: false, code: "invalid_path" };

    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(resolved.value.absolutePath, { bigint: true });
    } catch (error) {
      return { ok: false, code: mapFileReadError(error) };
    }
    if (before.isSymbolicLink()) return { ok: false, code: "symbolic_link" };
    if (!before.isFile()) return { ok: false, code: "not_a_regular_file" };
    if (before.size > BigInt(MAX_READ_BYTES)) return { ok: false, code: "file_too_large" };

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(resolved.value.absolutePath, "r");
    } catch (error) {
      return { ok: false, code: mapFileReadError(error) };
    }

    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== before.ino || opened.dev !== before.dev) {
        return { ok: false, code: "file_changed" };
      }

      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs
      ) {
        return { ok: false, code: "file_changed" };
      }
      if (bytes.byteLength > MAX_READ_BYTES) return { ok: false, code: "file_too_large" };

      return {
        ok: true,
        bytes,
        snapshot: {
          identity: `${before.dev.toString()}:${before.ino.toString()}`,
          size: Number(before.size),
          lastWriteTimeNs: before.mtimeNs,
          isFile: true,
          isSymbolicLink: false,
        },
      };
    } catch (error) {
      return { ok: false, code: mapFileReadError(error) };
    } finally {
      await handle.close();
    }
  }

  /** Read a text file for grep; returns null when the file is not readable. */
  async function readText(relativePath: string): Promise<string | null> {
    const result = await readFile(relativePath);
    if (!result.ok) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    } catch {
      return null;
    }
  }

  return { listDirectory, readFile, readText };
}

export type WindowsFileReader = ReturnType<typeof createWindowsFileReader>;

function toPosixRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.replace(/\\/g, "/").replace(/\/+$/, "");
}

function mapDirectoryError(error: unknown): DirectoryReadFailure {
  if (typeof error !== "object" || error === null) return "read_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return "read_failed";
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "access_denied";
    case "ENOTDIR":
      return "not_a_directory";
    default:
      return "read_failed";
  }
}

function mapFileReadError(error: unknown): FileReadFailureCode {
  if (typeof error !== "object" || error === null) return "read_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return "read_failed";
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "access_denied";
    case "EBUSY":
      return "locked";
    case "EISDIR":
    case "ENOTDIR":
      return "not_a_regular_file";
    default:
      return "read_failed";
  }
}

type FileReadFailureCode = Extract<FileReadResult, { ok: false }>["code"];
