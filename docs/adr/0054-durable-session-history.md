# ADR-0054: Durable Session History

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: V1_BASELINE section 7; ADR-0022

## Context

The entry point constructed `InMemoryEventLog`. The durable `JsonlEventLog` and
`JsonlCheckpointStore` existed, were tested, and were never used.

The consequence was the largest remaining usability gap: closing `lycwl` discarded
the entire Session — history, Todo state, approval records — so the product could not
be used across more than one sitting. It also meant a crash lost everything the
Harness had just done.

## Decision

Wire the durable log and give the coordinator a fixed Session identity.

### Session identity

`RuntimeCoordinator` gains an optional `sessionId`. When present, every Run appends
to that Session; when absent, each Run gets a fresh one, which stays correct for
tests and the demo runtime.

The entry point derives a **stable id from the workspace path**:

```
ws-<first 16 hex of sha256(normalised path)>
```

Normalisation lowercases and strips trailing separators, because Windows paths are
case-insensitive and `D:\proj` and `d:\proj\` must not become two Sessions. A random
id would have made every launch a new Session, which is exactly the problem being
fixed.

### Storage

`sessions/<sessionId>/events.jsonl` plus checkpoints, under the application data
directory. A launch that finds prior events prints the count, so a user knows the
history is being continued rather than silently reused.

## Verification

- 1177 tests pass across 256 suites; the vitest suite runs 12 render tests.
- Five tests drive the real JSONL log through the coordinator:
  - events reach disk under the fixed id;
  - a **second coordinator** over the same directory appends rather than replaces,
    and sequence numbers continue;
  - distinct Session ids stay separate;
  - a never-run Session reads as empty;
  - a truncated trailing line is reported as `invalid_event` while earlier events
    remain intact on disk.
- `pnpm run verify` exits 0.

## A Correction About Corruption Handling

My first corruption test assumed a partial trailing line would be tolerated. It is
not: the log returns `invalid_event`. That is the correct behaviour — a truncated
tail cannot be distinguished from real corruption, and guessing would let a damaged
history look healthy. The test was rewritten to assert the actual contract and to
prove the earlier events are still present in the file.

## What This Still Does Not Do

- **No replay into the conversation.** Events persist and are readable, but a new
  launch does not reconstruct prior conversation context; the model starts fresh.
  Continuing a Session means the record survives, not that the agent remembers.
- **No session picker or resume UI.** One workspace maps to one Session; there is no
  way to choose an older one.
- **No retention policy beyond what exists.** Sessions and attachments are kept until
  explicit deletion, but nothing implements that deletion yet.
- **No crash-recovery review flow.** A `waiting` Run found on restart is not surfaced.
- Checkpoints are written but not used to accelerate replay, because replay into a
  conversation is not implemented.

## Consequences

- The execution record survives a restart, which is a prerequisite for both auditing
  and any future resume.
- Two launches in the same project share one log, which is what a user would expect
  from "the same project".
- The gap between "recorded" and "remembered" is stated explicitly rather than
  implied by the word "persistence".

## Reassessment Conditions

Implement conversation reconstruction from events before claiming a resumed Session
continues the agent's context. Add a session picker when more than one Session per
workspace becomes meaningful.
