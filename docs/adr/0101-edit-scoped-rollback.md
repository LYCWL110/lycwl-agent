# ADR-0101: A Failed Syntax Check Reverts Only That Edit

- Status: Accepted (2026-11-26)
- Related: ADR-0075 (snapshots), ADR-0095 (approval control)

## Decision

The whole-Run snapshot and the edit snapshot are separate capabilities:

- `SnapshotStore.capture` keeps the first snapshot per path in a Run. It remains
  the source for the user's explicit `/undo`, which restores the Run's start.
- `SnapshotStore.captureEdit` always captures the current content before a
  single-file edit, even when the path was already captured for the Run.
- After the edit, the coordinator records the current digest. A failed syntax
  check calls `restoreEdit` with that post-edit digest.
- `restoreEdit` restores only when the current digest still matches the
  post-edit digest. A newer change is a `conflict`; the file is left alone.
- A syntax failure no longer calls the whole-Run reverter.

This makes two cases explicit:

1. edit A succeeds, edit B fails: A remains, B is restored or reported as a
   conflict.
2. the same file is edited successfully, then fails: the earlier successful
   version remains, not the Run-start version.

The failed edit event records `rollback: "reverted" | "conflict" | "unavailable"`;
`reverted` remains for older readers.

## Consequences

Each checked edit adds one content-addressed pre-edit snapshot, subject to the
existing per-Run file and byte limits. If the snapshot cannot be taken, the edit
is kept and the failure reports `rollback=unavailable`; it is not silently
undone through a broader path.

A concurrent writer after the edit wins. The Harness reports the conflict rather
than overwriting work it did not see.

## Reassessment Conditions

Revisit if edit snapshots need cross-process replay, or if the capture point must
move after approval rather than before dispatch.
