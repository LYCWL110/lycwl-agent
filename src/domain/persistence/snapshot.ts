/**
 * File snapshots for undo.
 *
 * A snapshot records a file's content before a mutation, so the change can be
 * reverted. This is not a version-control replacement: it holds one entry per
 * (Run, path) pair and exists to undo a bad edit, not to browse history.
 *
 * OpenCode's `snapshot.ts` builds a content-addressed tree inside a Git object
 * database. That is a large amount of machinery — it shells out to Git, creates a
 * shadow repository, and packs objects on a timer. This module stores the previous
 * bytes directly, which is enough to revert a single Run and needs no Git.
 *
 * The trade-off is honest: a snapshot of a 5 MiB file costs 5 MiB. The size cap
 * below refuses to snapshot a file larger than that, and a refused snapshot means
 * that file cannot be reverted through this path — it is reported, not silently
 * skipped.
 */

export const SNAPSHOT_LIMITS = Object.freeze({
  /** Above this, the file is not snapshotted and the fact is reported. */
  maxFileBytes: 5 * 1024 * 1024,
  /** At most this many files per Run, so one Run cannot fill the disk. */
  maxFilesPerRun: 256,
  /** Total bytes per Run. */
  maxTotalBytesPerRun: 64 * 1024 * 1024,
});

export type SnapshotEntry = Readonly<{
  /** Workspace-relative, forward-slash separated. */
  path: string;
  /** The content before the mutation; null when the file did not exist. */
  bytes: Uint8Array | null;
  /** Size of `bytes`, or 0 for a created file. */
  byteLength: number;
  /** SHA-256 of `bytes`, so a restore can verify what it writes. */
  sha256: string;
  capturedAtUtc: string;
}>;

export type SnapshotCapture =
  | Readonly<{ ok: true; entry: SnapshotEntry }>
  | Readonly<{ ok: false; code: "too_large" | "limit_exceeded" }>;

export type SnapshotBudget = Readonly<{
  files: number;
  bytes: number;
}>;

export const EMPTY_SNAPSHOT_BUDGET: SnapshotBudget = { files: 0, bytes: 0 };

/**
 * Decide whether a file can be snapshotted within the Run's budget.
 *
 * Checked before reading the file, so a huge file is refused without loading it.
 */
export function canSnapshot(
  budget: SnapshotBudget,
  byteLength: number,
): Readonly<{ ok: true }> | Readonly<{ ok: false; code: "too_large" | "limit_exceeded" }> {
  if (byteLength > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, code: "too_large" };
  if (budget.files >= SNAPSHOT_LIMITS.maxFilesPerRun) {
    return { ok: false, code: "limit_exceeded" };
  }
  if (budget.bytes + byteLength > SNAPSHOT_LIMITS.maxTotalBytesPerRun) {
    return { ok: false, code: "limit_exceeded" };
  }
  return { ok: true };
}

/** Account for a captured entry. */
export function addToBudget(budget: SnapshotBudget, entry: SnapshotEntry): SnapshotBudget {
  return { files: budget.files + 1, bytes: budget.bytes + entry.byteLength };
}

/**
 * Whether an existing entry should be kept.
 *
 * The first snapshot of a path within a Run wins: it holds the state before the Run
 * touched the file, which is what a revert to the Run's start means. A later
 * mutation of the same path must not overwrite that, or undo would only step back
 * one edit.
 */
export function shouldReplace(existing: SnapshotEntry | undefined): boolean {
  return existing === undefined;
}

/** A display name for the revert preview. */
export function describeSnapshot(entry: SnapshotEntry): string {
  return entry.bytes === null
    ? `${entry.path} (did not exist; revert deletes it)`
    : `${entry.path} (${entry.byteLength} bytes)`;
}
