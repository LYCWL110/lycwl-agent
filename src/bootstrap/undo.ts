import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SnapshotStore } from "../ports/snapshot-store.ts";

/**
 * Revert the files a Session changed.
 *
 * Undo restores the content captured before each mutation. Two properties matter:
 *
 * - **It writes only inside the workspace.** A snapshot path is already
 *   workspace-relative and normalized by the store, but the join is repeated here
 *   with a resolved-prefix check so a stored path cannot escape even if the index
 *   was edited on disk.
 * - **It is not a git operation.** Nothing is committed, staged or stashed, so undo
 *   cannot disturb a working tree the user is managing themselves.
 *
 * A file that did not exist before the Run is deleted, which is the correct undo for
 * a creation. A file whose snapshot is missing or damaged is reported and left
 * alone: writing an unverified snapshot over a working file would be worse than
 * leaving the change in place.
 */

export type UndoResult =
  | Readonly<{ ok: true; files: number; skipped: readonly string[] }>
  | Readonly<{ ok: false; code: "no_snapshots" | "undo_failed" }>;

export type UndoOptions = Readonly<{
  store: SnapshotStore;
  workspaceRoot: string;
  /** Runs to revert, newest first. */
  runIds: readonly string[];
}>;

export async function undoSessionChanges(options: UndoOptions): Promise<UndoResult> {
  const resolvedRoot = path.resolve(options.workspaceRoot);
  const reverted = new Set<string>();
  const skipped: string[] = [];

  for (const runId of options.runIds) {
    const entries = await options.store.list(runId);
    for (const entry of entries) {
      if (reverted.has(entry.path)) continue;

      const absolute = path.resolve(resolvedRoot, ...entry.path.split("/"));
      // The prefix check must include the separator, or `workspace-evil` would pass
      // for a root of `workspace`.
      if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
        skipped.push(entry.path);
        continue;
      }

      if (entry.bytes === null) {
        // The file did not exist before this Run; undo removes it.
        await rm(absolute, { force: true }).catch(() => undefined);
        reverted.add(entry.path);
        continue;
      }

      const bytes = await options.store.read(runId, entry);
      if (bytes === null) {
        // A missing or damaged snapshot is not a reason to overwrite anything.
        skipped.push(entry.path);
        continue;
      }
      try {
        await writeFile(absolute, bytes);
        reverted.add(entry.path);
      } catch {
        skipped.push(entry.path);
      }
    }
  }

  if (reverted.size === 0 && skipped.length === 0) {
    return { ok: false, code: "no_snapshots" };
  }
  if (reverted.size === 0) return { ok: false, code: "undo_failed" };
  return { ok: true, files: reverted.size, skipped };
}
