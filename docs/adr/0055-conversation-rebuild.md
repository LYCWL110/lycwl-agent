# ADR-0055: Rebuilding Conversation From Events

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0054

## Context

ADR-0054 made Session history durable and stated plainly that "persistence is not
memory": events reached disk, but a new launch started the model with no prior
conversation. Continuing a Session meant only that the record survived.

The gap had a second cause: the events did not carry enough to rebuild a
conversation. `tool_call_received` had no arguments, and `tool_execution_finished`
carried the result text but not the tool name.

## Decision

Record the missing facts, then rebuild.

### Event additions

- `tool_call_received.arguments` — the validated arguments, so the assistant turn can
  be reconstructed with its calls intact;
- `tool_execution_finished.toolName` — optional, so a result can be rebuilt without a
  lookup.

Both are additive. Existing readers are unaffected.

### Rebuild (`application/coordinator/conversation-rebuild.ts`)

`rebuildConversation` walks the events and produces neutral conversation items:

| Event | Contributes |
| --- | --- |
| `run_started` | user turn |
| `model_response_validated` | assistant text (first of a Run only) |
| `tool_call_received` | a tool call with its arguments |
| `tool_execution_finished` / `_denied` / `_cancelled` | the matching tool result |

Rules that matter:

- **Only terminal Runs contribute.** A Run that was active or waiting when the
  process stopped is dropped, not guessed at.
- **The first validated response of a Run owns the calls.** A later response is the
  follow-up turn; letting it overwrite the text produced a history where the
  assistant said something it never said at that point.
- **Denied and unknown outcomes keep their status.** A rebuilt history must not
  upgrade a denial into a success.
- **An unpaired call is a failure, not a repair.** If a terminal Run has a call with
  no recorded result, the rebuild reports `unpaired_tool_call` rather than inventing
  one.

`trimConversation` bounds the rebuilt history and only cuts at a turn boundary, since
starting with a tool result would answer a call nobody made.

### Wiring

The composition root rebuilds prior history before constructing the coordinator and
passes it as `priorConversation`, which the coordinator prepends before the new task.
A rebuild failure is reported in the launch summary and the Run starts fresh, rather
than presenting a damaged history as a new Session.

## Defects Found While Testing

Two, both in my own first version, and both caught by the tool-round-trip case:

1. **Results were keyed by the wrong id.** `results` was indexed by
   `providerToolCallId` while `tool_execution_finished` carries the internal
   `toolCallId`, so no result ever matched and the rebuilt history silently lost
   every tool result. The fix maps internal to provider ids through the recorded
   call.
2. **A later assistant response overwrote the calling turn's text.** The rebuilt
   assistant turn said `done` instead of `looking`, which is a history the model never
   produced.

## Verification

- 1188 tests pass across 259 suites; the vitest suite runs 12 render tests.
- Nine unit tests cover a full tool round trip, denied and unknown statuses, multiple
  Runs, an unfinished Run being skipped, an empty log, and the trim boundary.
- Two integration tests drive **two real launches** against one data directory: the
  second request carries the first Run's task text before the new task, and a
  different Session id starts blank.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No session picker.** One workspace maps to one Session; an older one cannot be
  chosen.
- **History is trimmed at 40 items** by a fixed bound, not by the C04 budget, so a
  long Session resumes with a truncated history rather than a measured one.
- **No `waiting` Run resumption.** A Run that was waiting when the process stopped is
  dropped from the rebuilt history; resuming it is a separate flow that does not
  exist.
- **No compaction interaction.** A `context_compacted` event is ignored by the
  rebuild, so a resumed Session replays the original turns rather than the summary.
- No streaming, and one of four protocols remains.

## Consequences

- A resumed Session now continues with its conversation, which is what "persistence"
  was supposed to mean.
- The event log is now sufficient to reconstruct the neutral history, so any future
  audit or export has the same source.
- The remaining resume gaps are bounded and named rather than implied.

## Reassessment Conditions

Handle `context_compacted` in the rebuild before claiming a compacted Session resumes
correctly. Derive the trim bound from the budget when the tokenizer is real.
