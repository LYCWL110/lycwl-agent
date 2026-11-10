# ADR-0033: No-Progress Detection And Stalled-Stream Abort

- Status: Confirmed implementation of already-confirmed section 7 design
- Date: 2026-11-05
- Related: V1_BEHAVIOR_CONTRACTS.md section 7; C04/C05

## Context

Section 7 confirmed detection of no-progress loops and stalled streams, with
explicit numbers. None of it existed. The consequence was concrete: a model that
kept issuing the same read forever was bounded only by the 32-round cap, and a
stream that sent heartbeats without content would burn the whole 180s attempt
doing nothing.

## Decision

`domain/run/no-progress.ts` implements two detectors plus stream evaluation, and
the coordinator wires the call detector so it actually blocks.

### Identical call fingerprints

A fingerprint is `{toolName, toolVersion, normalizedInput, resourceVersion}`.
Recorded count drives the decision:

| Identical records | Decision |
| --- | --- |
| 0-1 | proceed |
| 2 | warn (`no_progress`) |
| 2+ on the next call | block before dispatch |

The coordinator blocks **before** dispatch and enters
`waiting(recovery_review)`, so the call never executes: detection cannot replay a
side effect or exempt any budget. The block record and the `run_waiting` event are
both written.

Key design choices worth naming:

- **The coordinator passes `resourceVersion: null`.** It does not read resources,
  so it cannot assert a version. Null means unknown, which is stricter: repeated
  identical input counts as identical rather than being excused by a guess. A
  caller that can prove the resource changed supplies a real version and is not
  flagged.
- **Arguments are canonicalized by sorting keys.** Otherwise the same call written
  with a different key order would look like progress. This is comparison
  canonicalization, not validation, and a test asserts key-order insensitivity.
- **New user input resets the identical-call counter** without touching failure
  history, because it is genuine progress.
- Free-text error messages are never part of a fingerprint. Identical failures
  often produce different text, which would make every failure look distinct and
  defeat the whole comparison.

### Recovery-path failures

`checkRecoveryFailures` compares `{category, code, stage}` along a `pathId`: warn
at three consecutive equivalent failures, wait at five. It is cross-call and
strictly narrower than C05: it does not raise the three-attempt cap for a single
logical request, and non-retryable or budget-exhausted errors still end earlier
under the existing rules.

`resumeDetectionWindow` appends a boundary record rather than deleting history, so
an explicit user resume starts a new window while accumulated history and consumed
budget remain. Reaching the threshold again waits again; there is no permanent
exemption.

### Stream evaluation

`evaluateStreamProgress` applies two clocks: 90s to the first effective event, then
60s idle without effective content. `classifyStreamEvent` makes only non-empty
text or tool-argument deltas effective; heartbeats, usage-only events and repeated
empty deltas refresh neither clock.

The attempt-cap case returns `continue` on purpose: the existing 180s cap owns it,
and detection must not add a second, competing timeout. Aborts route into the
existing transient-retry path; they never dispatch a tool from an incomplete
response.

### Background polling

`isObservedBackgroundPoll` states the exception as code: polling a still-running
task that produced new output is progress, not a stall. It does not exempt the
task or Run from their own time limits.

## What This Is Not

- **Stream evaluation is not wired.** There is no streaming transport yet, so the
  clocks and classifier have unit coverage only. They are policy ready for one.
- **Failure-path detection is not wired** to the coordinator's error handling; only
  the identical-call detector is. Recovery history is not yet persisted as events,
  so counts are not rebuildable across a restart.
- The thresholds are confirmed V1 defaults that may misfire on a genuinely slow
  model. That risk is recorded where the numbers are, not argued away.

## Consequences

- A tight read loop now stops before the third identical dispatch instead of
  consuming the round budget, and the user sees a recovery wait.
- Detection can only warn or wait. It cannot grant approval, retry an unknown
  outcome, or extend any budget, which is asserted by tests rather than promised.
- Existing behaviour for varied calls is unchanged; three distinct reads still
  complete normally.

## Reassessment Conditions

Wire stream and failure detection only with the transports and event persistence
that make them observable. Revisit the thresholds only with measured slow-model
data, never to make a failing case pass.
