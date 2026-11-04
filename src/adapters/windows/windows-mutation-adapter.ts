import { lstat, readdir, type realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BATCH_LIMITS,
  type DeleteTargetFacts,
  type RenameFacts,
} from "../../domain/mutation/batch.ts";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.ts";

/**
 * Real Windows delete/rename adapter (Stage 2C).
 *
 * Scope is deliberately narrow: one ordinary file or one empty directory per
 * delete target, and one same-volume no-overwrite rename. Reparse points are
 * refused rather than followed. There is no recursive delete, no trash, no
 * backup and no overwrite.
 */

export type MutationAdapterFailure =
  | "invalid_path"
  | "not_found"
  | "access_denied"
  | "locked"
  | "not_a_regular_file"
  | "directory_not_empty"
  | "reparse_point_unsupported"
  | "target_exists"
  | "different_volume"
  | "target_inside_source"
  | "tree_too_large"
  | "operation_failed";

export function createWindowsMutationAdapter(options: Readonly<{ workspaceRoot: string }>) {
  const { workspaceRoot } = options;

  async function inspectDeleteTargets(
    requested: readonly string[],
  ): Promise<readonly DeleteTargetFacts[]> {
    const facts: DeleteTargetFacts[] = [];
    for (const candidate of requested) {
      facts.push(await inspectDeleteTarget(candidate));
    }
    return facts;
  }

  async function inspectDeleteTarget(relativePath: string): Promise<DeleteTargetFacts> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) {
      return {
        path: relativePath,
        exists: false,
        isDirectory: false,
        isSymbolicLink: false,
        isEmptyDirectory: false,
      };
    }

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(supplied.value.absolutePath, { bigint: true });
    } catch {
      return {
        path: relativePath,
        exists: false,
        isDirectory: false,
        isSymbolicLink: false,
        isEmptyDirectory: false,
      };
    }

    const isSymbolicLink = stats.isSymbolicLink();
    const isDirectory = stats.isDirectory();
    let isEmptyDirectory = false;
    if (isDirectory) {
      try {
        const children = await readdir(supplied.value.absolutePath);
        isEmptyDirectory = children.length === 0;
      } catch {
        isEmptyDirectory = false;
      }
    }

    return {
      path: relativePath,
      exists: true,
      isDirectory,
      isSymbolicLink,
      isEmptyDirectory,
    };
  }

  /** Delete exactly one ordinary file or one empty directory. */
  async function deletePath(relativePath: string): Promise<void> {
    const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!supplied.ok) throw new Error("invalid_path");
    if (!supplied.value.withinWorkspace) throw new Error("invalid_path");

    const stats = await lstat(supplied.value.absolutePath, { bigint: true });
    if (stats.isSymbolicLink()) throw new Error("reparse_point_unsupported");

    if (stats.isDirectory()) {
      const children = await readdir(supplied.value.absolutePath);
      if (children.length > 0) throw new Error("directory_not_empty");
      await rmdir(supplied.value.absolutePath);
      return;
    }
    if (!stats.isFile()) throw new Error("not_a_regular_file");
    await unlink(supplied.value.absolutePath);
  }

  async function inspectRename(from: string, to: string): Promise<RenameFacts> {
    const empty: RenameFacts = {
      from,
      to,
      sourceExists: false,
      targetExists: false,
      sameVolume: false,
      sourceIsSymbolicLink: false,
      treeEntries: 0,
      manifestBytes: 0,
      targetInsideSource: false,
      aliasAmbiguous: false,
    };

    const suppliedFrom = resolveWorkspacePath(workspaceRoot, from);
    const suppliedTo = resolveWorkspacePath(workspaceRoot, to);
    if (!suppliedFrom.ok || !suppliedTo.ok) return empty;
    if (!suppliedFrom.value.withinWorkspace || !suppliedTo.value.withinWorkspace) {
      return empty;
    }

    const fromPath = suppliedFrom.value.absolutePath;
    const toPath = suppliedTo.value.absolutePath;

    let sourceStats: Awaited<ReturnType<typeof lstat>>;
    try {
      sourceStats = await lstat(fromPath, { bigint: true });
    } catch {
      return empty;
    }

    const targetExists = await exists(toPath);
    const targetInsideSource =
      toPath.toLowerCase().startsWith(`${fromPath.toLowerCase()}\\`) ||
      toPath.toLowerCase() === fromPath.toLowerCase();

    // Windows case-only renames resolve to the same identity and are refused.
    const aliasAmbiguous = sameIdentityText(fromPath, toPath);

    let treeEntries = 1;
    let manifestBytes = fromPath.length + toPath.length;
    if (sourceStats.isDirectory()) {
      const counted = await countTree(fromPath);
      treeEntries = counted.entries;
      manifestBytes += counted.bytes;
    }

    return {
      from,
      to,
      sourceExists: true,
      targetExists,
      sameVolume: sameVolume(fromPath, toPath),
      sourceIsSymbolicLink: sourceStats.isSymbolicLink(),
      treeEntries,
      manifestBytes,
      targetInsideSource,
      aliasAmbiguous,
    };
  }

  /** Rename one same-volume pair, never overwriting an existing target. */
  async function renamePath(from: string, to: string): Promise<void> {
    const suppliedFrom = resolveWorkspacePath(workspaceRoot, from);
    const suppliedTo = resolveWorkspacePath(workspaceRoot, to);
    if (!suppliedFrom.ok || !suppliedTo.ok) throw new Error("invalid_path");
    if (!suppliedFrom.value.withinWorkspace || !suppliedTo.value.withinWorkspace) {
      throw new Error("invalid_path");
    }

    const fromPath = suppliedFrom.value.absolutePath;
    const toPath = suppliedTo.value.absolutePath;

    const sourceStats = await lstat(fromPath, { bigint: true });
    if (sourceStats.isSymbolicLink()) throw new Error("reparse_point_unsupported");

    // Re-check immediately before the single OS call.
    if (await exists(toPath)) throw new Error("target_exists");
    if (!sameVolume(fromPath, toPath)) throw new Error("different_volume");
    if (toPath.toLowerCase().startsWith(`${fromPath.toLowerCase()}\\`)) {
      throw new Error("target_inside_source");
    }
    if (sameIdentityText(fromPath, toPath)) throw new Error("target_exists");

    const counted = sourceStats.isDirectory()
      ? await countTree(fromPath)
      : { entries: 1, bytes: 0 };
    if (
      counted.entries > BATCH_LIMITS.maxRenameTreeEntries ||
      counted.bytes > BATCH_LIMITS.maxRenameManifestBytes
    ) {
      throw new Error("tree_too_large");
    }

    await rename(fromPath, toPath);
  }

  return { inspectDeleteTargets, deletePath, inspectRename, renamePath };
}

export type WindowsMutationAdapter = ReturnType<typeof createWindowsMutationAdapter>;

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target, { bigint: true });
    return true;
  } catch {
    return false;
  }
}

async function countTree(root: string): Promise<Readonly<{ entries: number; bytes: number }>> {
  let entries = 0;
  let bytes = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    let children: string[];
    try {
      children = await readdir(current);
    } catch {
      continue;
    }
    for (const child of children) {
      entries += 1;
      bytes += child.length;
      if (entries > BATCH_LIMITS.maxRenameTreeEntries) return { entries, bytes };
      const childPath = path.join(current, child);
      try {
        const stats = await lstat(childPath, { bigint: true });
        if (stats.isDirectory() && !stats.isSymbolicLink()) queue.push(childPath);
      } catch {
        // Vanished during traversal; it still counted as an entry.
      }
    }
  }
  return { entries, bytes };
}

function sameVolume(left: string, right: string): boolean {
  const drive = (value: string): string | null => {
    const match = /^([A-Za-z]):/.exec(value);
    if (match !== null) return (match[1] ?? "").toUpperCase();
    if (value.startsWith("\\\\")) {
      const parts = value.slice(2).split("\\");
      return `\\\\${(parts[0] ?? "").toUpperCase()}\\${(parts[1] ?? "").toUpperCase()}`;
    }
    return null;
  };
  const leftDrive = drive(left);
  const rightDrive = drive(right);
  if (leftDrive === null || rightDrive === null) return false;
  return leftDrive === rightDrive;
}

/** True when the two paths differ only by case or trailing separators. */
function sameIdentityText(left: string, right: string): boolean {
  return left.replace(/\\+$/, "").toLowerCase() === right.replace(/\\+$/, "").toLowerCase();
}

export type { DeleteTargetFacts, RenameFacts };
export type { realpath };
