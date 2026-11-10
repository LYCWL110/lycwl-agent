# ADR-0030: Context Capacity Arithmetic And Skeleton-First Compaction Planning

- Status: Confirmed implementation of already-confirmed C04 / P02 design
- Date: 2026-11-05
- Related: V1_CONTRACTS.md C04/C05; V1_DESIGN_SUPPLEMENTS.md P02; ADR-0016

## Context

C04 fixes the context arithmetic and P02 fixes how a compaction request may be
built. Neither existed: `run-budget.ts` counted compactions but there was no
capacity computation, no grouping, no bounded construction, and no artifact
validation.

## Decision

### Capacity arithmetic (`domain/context/context-budget.ts`)

Implements the C04 equations exactly and pins the documented example as a test:
for W=8192, userMaxOutput=4096 and sufficient modelMaxOutput, the result is
O=1638, G=512, P=6042, and with F=3000 → H=3042, recent=1826, summary=1216. The
same test also pins that F=5400 must fail.

The failure modes are the point:

- `window === null` → `model_context_unknown`, never a guessed window;
- W < 8192 → `context_window_too_small`;
- H < 1024 → `context_capacity_insufficient`, because removing mandatory safety
  constraints to fit is not an option the contract allows.

`decideRequestFit` encodes one subtle rule correctly: above the 80% trigger but
still within P, an **irreducible** context may be sent. The trigger is an
optimisation; only exceeding P blocks. My first implementation got this wrong and
returned `cannot_send` for the irreducible case — the test caught the contradiction
with C04 before it shipped.

### Compaction planning (`domain/context/compaction.ts`)

Order of construction is contractual and enforced:

1. **Skeleton first** for every summarised group: identity, order, source kind,
   every call/result id with its terminal status preserved verbatim.
2. **Fail explicitly** if `fixed + skeleton` exceeds the auxiliary input budget.
   Groups are never randomly dropped and constraints are never trimmed.
3. **Fill leftover space** with reducible bodies, newest old group first, allowing
   `full → excerpt → reference_only`.

`selectRecentSuffix` never splits a group. When the newest group alone exceeds
`recentBudget` it moves entirely into the summarised set and the suffix is empty,
because separating a call from its result produces an illegal protocol history.

`renderSkeletonBlock` states in the block itself that `reference_only` means the
body never entered, and pins non-succeeded statuses. That is what stops a
summariser from writing a denial or an unknown outcome as a success: the status is
carried in structure, not left to prose.

### Artifact validation

`validateCompactionArtifact` rejects a tool-proposing response, coverage that does
not reach the source high-water seq, a missing required source, an unknown source,
a broken call/result linkage, an uncovered pinned constraint, and an over-budget
output.

`unverifiedClaims` exists so a caller cannot accidentally treat
`completedClaims` as proof: a claim with no evidence reference stays narration.

## What This Is Not

- **No model call.** This decides what a compaction request may contain and proves
  whether it can be built. The auxiliary request, its separate C03 binding, the
  disclosure re-check and the durable `ContextCompacted` publication are not
  implemented.
- **No tokenizer.** Every number is an estimate under the 1.20 conservative factor,
  labelled as such. UTF-16 units are not token counts, and the contract says so.
- **Structural validation is not semantic correctness.** The ADR that owns the
  design states this; the code does not pretend otherwise, and unsupported claims
  remain unverified rather than becoming facts.
- No `ContextCompacted` event, no coverage manifest persisted as an artifact, and
  no coordinator wiring.

## Consequences

- The arithmetic and the construction rules are now executable and pinned to the
  contract's own worked examples, including the failure cases.
- Estimating skeleton cost as `members * 8 + 16` is an approximation. It is honest
  about being one, and it is the same class of estimate as everything else here.
- No behaviour changed, because nothing calls these yet.

## Reassessment Conditions

Revisit the skeleton cost model only with measured tokenizer data. Wire the
compaction request only together with the auxiliary C03 binding, disclosure
re-check and durable publication — a plan without those is not a compaction.
