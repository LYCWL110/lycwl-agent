import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileSnapshotFacts } from "../../services/files/consistent-snapshot.ts";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.ts";
import type { ResolvedReadTarget } from "../../services/permission/resolved-read-policy.ts";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.ts";

/**
 * Real Windows read-only filesystem adapter.
 *
 * Read-only by construction: this module has no write, delete, rename or spawn
 * capability. Every call re-validates the path through the existing policy so
 * ADS, device namespaces, reserved names and traversal are rejected before any
 * OS call.
 */

export type InspectFailure = Readonly<{
  ok: false;
  code:
    | "invalid_path"
    | "not_found"
    | "access_denied"
    | "locked"
    | "read_failed"
    | "not_a_regular_file";
}>;

export type InspectedTarget = Readonly<{
  ok: true;
  target: ResolvedReadTarget;
  snapshot: FileSnapshotFacts;
}>;

export type InspectResult = InspectedTarget | InspectFailure;

export type WindowsFsAdapterOptions = Readonly<{
  workspaceRoot: string;
}>;

export function createWindowsFsAdapter(options: WindowsFsAdapterOptions) {
  const { workspaceRoot } = options;

  /**
   * Inspect one target: validate the supplied path, resolve reparse points, then
   * report identity facts for the resolved path.
   */
  async function inspect(requestedPath: string): Promise<InspectResult> {
    const supplied = resolveWorkspacePath(workspaceRoot, requestedPath);
    if (!supplied.ok) return { ok: false, code: "invalid_path" };

    if (isPosixWorkspaceRoot(workspaceRoot)) {
      try {
        const linkFacts = await lstat(supplied.value.absolutePath, { bigint: true });
        if (linkFacts.isSymbolicLink()) {
          return {
            ok: true,
            target: {
              requestedPath: supplied.value.absolutePath,
              resolvedPath: supplied.value.absolutePath,
              isDirectory: false,
              isSymbolicLink: true,
            },
            snapshot: {
              identity: `${linkFacts.dev}:${linkFacts.ino}`,
              size: Number(linkFacts.size),
              lastWriteTimeNs: linkFacts.mtimeNs,
              isFile: false,
              isSymbolicLink: true,
            },
          };
        }
      } catch (error) {
        return { ok: false, code: mapError(error) };
      }
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(supplied.value.absolutePath);
    } catch (error) {
      const mapped = mapError(error);
      return { ok: false, code: mapped };
    }

    const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
    if (!resolved.ok) return { ok: false, code: "invalid_path" };

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(resolved.value.absolutePath, { bigint: true });
    } catch (error) {
      return { ok: false, code: mapError(error) };
    }

    const isSymbolicLink = stats.isSymbolicLink();
    const isDirectory = stats.isDirectory();
    return {
      ok: true,
      target: {
        requestedPath: supplied.value.absolutePath,
        resolvedPath: resolved.value.absolutePath,
        isDirectory,
        isSymbolicLink,
      },
      snapshot: {
        identity: `${stats.dev.toString()}:${stats.ino.toString()}`,
        size: Number(stats.size),
        lastWriteTimeNs: stats.mtimeNs,
        isFile: stats.isFile(),
        isSymbolicLink,
      },
    };
  }

  return {
    workspaceRoot,
    inspect,
    /** True only when the adapter may read this target. */
    isReadable: (result: InspectResult): boolean =>
      result.ok && result.snapshot.isFile && !result.snapshot.isSymbolicLink,
    join: (relative: string) => path.join(workspaceRoot, relative),
  };
}

export type WindowsFsAdapter = ReturnType<typeof createWindowsFsAdapter>;

function mapError(error: unknown): InspectFailure["code"] {
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
      return "not_a_regular_file";
    default:
      return "read_failed";
  }
}
