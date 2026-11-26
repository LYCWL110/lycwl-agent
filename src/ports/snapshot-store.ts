import type { SnapshotEntry } from "../domain/persistence/snapshot.ts";

/**
 * Pre-change file snapshot storage.
 *
 * The coordinator needs somewhere to keep the content it is about to overwrite, but
 * it must not know where that is. Keeping the type here lets the application layer
 * depend on the capability rather than on the file system.
 */
export type SnapshotStore = Readonly<{
  /**
   * Capture the current content of a workspace-relative path.
   *
   * A path that does not exist is recorded as a creation, so reverting it deletes
   * the file.
   */
  capture: (input: {
    runId: string;
    relativePath: string;
  }) => Promise<
    | Readonly<{ ok: true; entry: SnapshotEntry }>
    | Readonly<{ ok: false; code: "too_large" | "limit_exceeded" | "capture_failed" }>
  >;
  /**
   * Capture the current content for a single edit, regardless of an earlier
   * whole-Run capture of the same path. This is what lets a failed syntax check
   * restore only that edit instead of undoing every change in the Run.
   */
  captureEdit: (input: {
    runId: string;
    relativePath: string;
  }) => Promise<
    | Readonly<{ ok: true; entry: SnapshotEntry }>
    | Readonly<{ ok: false; code: "too_large" | "limit_exceeded" | "capture_failed" }>
  >;
  /** Current SHA-256 of a workspace path, or null when it does not exist. */
  currentDigest: (
    relativePath: string,
  ) => Promise<
    Readonly<{ ok: true; sha256: string | null }> | Readonly<{ ok: false; code: "capture_failed" }>
  >;
  /**
   * Restore one edit snapshot when the file still has the post-edit digest.
   * A changed file is a conflict and is left alone; it is never overwritten.
   */
  restoreEdit: (input: {
    runId: string;
    entry: SnapshotEntry;
    expectedCurrentSha256: string | null;
  }) => Promise<
    Readonly<{ ok: true }> | Readonly<{ ok: false; code: "conflict" | "restore_failed" }>
  >;
  /** Every entry captured for a Run, in capture order. */
  list: (runId: string) => Promise<readonly SnapshotEntry[]>;
  /** The original bytes for an entry, or null when the snapshot is unusable. */
  read: (runId: string, entry: SnapshotEntry) => Promise<Uint8Array | null>;
  /** Remove a Run's snapshots after a successful revert or on Session close. */
  discard: (runId: string) => Promise<void>;
}>;
