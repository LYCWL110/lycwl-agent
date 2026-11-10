# ADR-0046: Wiring Compaction Into The Request Loop

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0030 (planning), ADR-0034 (neutral history)

## Context

ADR-0030 built compaction *planning* — grouping, skeleton-first construction,
artifact validation — but nothing called it, so a long conversation failed at the
provider instead of being compacted. This wires it in.

## Decision

### Configuration

`ProviderConfig` gains `contextWindow: number | null`. It is **optional on
purpose**: C04 says an unknown window is `model_context_unknown`, and guessing a
window would produce a budget the model does not actually have. A null window means
budgeting and compaction are skipped entirely, and an oversized prompt fails at the
provider visibly rather than being silently trimmed.

### Grouping (`application/coordinator/compaction-service.ts`)

An assistant turn absorbs the tool results that answer its calls, forming one atomic
group. Splitting them would let a plan summarise a call while keeping its result,
which is an illegal protocol history. A denied or unknown result keeps its status in
the skeleton, so a summary cannot upgrade it.

### Ordering in the loop

Compaction runs at the same boundary as guidance refresh, before the request:

1. estimate the prompt with the 1.20 conservative factor;
2. below the trigger → send;
3. above the trigger and reducible → compact;
4. above P → fail without sending.

After a successful compaction the conversation becomes `[artifact, ...recentSuffix]`
and a `context_compacted` event records the artifact hash, covered groups, retained
groups, high-water seq and the auxiliary estimate.

### Failure handling

- A capacity failure is terminal for the request: sending the uncompacted prompt
  would exceed the budget that just failed.
- An invalid artifact or a failed auxiliary request retries **once**, matching the
  C05 two-attempt auxiliary cap, then records `attempts_exhausted` and attempts the
  request as-is. A summarisation failure does not by itself fail the Run.
- The old context is never mutated until validation succeeds.

## Defect Found While Testing

My first trigger test opened with a provider that never returned a tool call. The
loop therefore ran exactly one round, `#maybeCompact` saw only the initial user
message, and nothing exceeded the trigger. The test asserted "compact, reject, or
fail" and failed all three.

The fix was in the test — keep the loop alive with a tool call — but it exposed
something worth stating: **the very first request in a Run can never be compacted**,
because at that point the only content is the task and the guidance. That is correct
behaviour, and it means a compaction test must drive at least two rounds.

## Verification

- 1090 tests pass across 236 suites; the vitest suite runs 12 render tests.
- Grouping tests assert assistant-plus-results stay together and a denied status is
  preserved.
- Artifact tests reject non-JSON, a wrong schema version and a tool-proposing reply.
- Two coordinator tests assert a small conversation is **not** compacted and that no
  budget means no compaction.
- A trigger test drives real rounds with a 30,000-character reply and asserts that
  an oversized conversation compacts, rejects, or fails — never sends as if fine.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **The artifact body is not rebuilt into the prompt.** The replacement turn is a
  rendered summary; the original message bodies are not re-included at full
  fidelity even for `full` representation groups. This is a real limitation: a
  `full` group should arguably contribute its text, not just its member list.
- **No `ContextCompacted` replay support.** The event is written but replay does not
  reconstruct the compacted view.
- **Compaction is not exercised against a real model**, so whether a real summariser
  produces a valid artifact is unknown.
- Constraint coverage is validated against an empty set, because pinned constraints
  are not tracked yet.
- No streaming, and three of four protocols remain unimplemented.

## Consequences

- A long Run now compacts instead of failing, and the decision is recorded.
- The unknown-window default keeps the honest failure mode: no budget, no silent
  truncation.
- The `full` representation limitation is documented rather than hidden.

## Reassessment Conditions

Rebuild `full`-representation bodies into the replacement turn before claiming
fidelity. Add replay support together with the event store work.
