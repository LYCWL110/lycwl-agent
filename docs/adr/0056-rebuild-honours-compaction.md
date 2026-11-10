# ADR-0056: Rebuild Honours Compaction

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0046 (compaction wiring), ADR-0055 (conversation rebuild)

## Context

ADR-0055 recorded that the rebuild ignored `context_compacted`, so a resumed Session
replayed the original turns that a compaction had replaced. That presents a history
the model no longer holds: the whole point of compacting was that those turns are gone.

The gap had a second cause, the same shape as before: the event did not carry the
summary. It recorded that a compaction happened, which groups it covered, and a hash
of the artifact — but not the text the model actually received.

## Decision

Record the summary, then let the rebuild use it.

### Event

`context_compacted` gains `summaryText`: the rendered summary that replaced the
summarised groups. A hash is useful for integrity, but a hash cannot be replayed.

### Rebuild

`rebuildConversation` tracks a per-Run `compactionSummary`. When set:

- the Run contributes the **summary** instead of its original task text;
- the summary is cleared when the Run flushes, so it cannot leak into a later Run;
- a Run with no compaction behaves exactly as before.

## Verification

- 1192 tests pass across 260 suites; the vitest suite runs 12 render tests.
- Four tests cover: the summary replaces the original task; a later Run keeps its own
  task while the earlier compacted one contributes the summary; a non-compacted Run is
  unchanged; and exactly one summary turn appears when only one Run compacted.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **Post-compaction turns are not separately preserved.** The rebuild emits the
  summary, but the turns that came *after* the compaction within the same Run are not
  distinguished from the ones before it. A precise rebuild would keep
  `[summary, ...turns after the compaction]`, and that needs the event to record which
  turns survived.
- **No ordering guarantee against multiple compactions in one Run.** The last summary
  wins, which is correct for the current single-pass flow but not proven for repeated
  compactions.
- **The summary text is stored in the event**, which duplicates content that also
  exists in the conversation. That is deliberate — a summary is small and is the only
  representation of the replaced turns — but it is a second copy to keep consistent.
- No session picker, no `waiting` Run resumption, and one of four protocols remains.

## Consequences

- A resumed compacted Session now shows what the model actually holds rather than a
  longer history it never had.
- The event log is sufficient to reconstruct the post-compaction view, which is what
  an audit of a compacted Session needs.
- The remaining imprecision — turns after the compaction — is stated rather than
  implied by the word "rebuild".

## Reassessment Conditions

Record which turns survived a compaction before claiming a precise post-compaction
rebuild. Revisit the stored-summary duplication if the summary grows large.
