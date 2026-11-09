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
  /** Every entry captured for a Run, in capture order. */
  list: (runId: string) => Promise<readonly SnapshotEntry[]>;
  /** The original bytes for an entry, or null when the snapshot is unusable. */
  read: (runId: string, entry: SnapshotEntry) => Promise<Uint8Array | null>;
  /** Remove a Run's snapshots after a successful revert or on Session close. */
  discard: (runId: string) => Promise<void>;
}>;
