# ADR-0005: Adopt Compatible V1 Runtime Contract Selections

Date: 2026-10-30.
Status: compatible selections adopted through the user's request to confirm
the supplied architecture/contracts document; C09/C10 exceptions remain pending.
Design/documentation only, not implementation authorization.

Follow-up: [ADR-0006](0006-non-shell-environment-configuration.md) records the
user's subsequent explicit C09 confirmation. Its typed per-tool direction
resolves the C09 design gap without adopting the source's Shell-only
replacement. C10 exceptions and exact schemas/tests remain open.

Subsequent confirmation: [ADR-0007](0007-provider-key-length-policy.md) settles
C10 key-length policy: no universal minimum, verified Provider constraints,
and unchanged short-key exact checking with accepted incidental blocking.
The import disposition above is historical; C03 redisclosure and exact
schemas/tests remain open, not C09/C10's reconciled policy choices.

Further confirmation: [ADR-0008](0008-sensitive-context-redisclosure.md) records
user agreement as the C03 redisclosure boundary. References below to pending
redisclosure selection describe the import-time gap; current policy is
confirmed while exact consent/provenance/state schemas and tests remain open.

## Problem

The baseline selected Runtime components but left ten cross-component behavior
groups insufficiently precise. The user supplied a consolidated contract
document to resolve them without repeating settled questions.

## Evidence And Constraints

The full 1,578-line source and its hash are recorded in
[CONTRACTS_REVIEW.md](../architecture/CONTRACTS_REVIEW.md). Existing R01-R03 and
AGENTS.md take precedence over conflicting source clauses.

Prior book evidence supports append-only facts/checkpoints (3.1.4, p.76),
failure classification/recovery (5.1.5, pp.126-128), and persistent trajectories
without using them as the primary inter-Agent channel (10.4, p.276). No claim
is made that the book specifies these exact budgets, grants, or algorithms.
Reference observations and their source limitations remain in AGENTS.md and
BASELINE_REVIEW.md; this is not a new comprehensive project audit.

## Candidates And Tradeoffs

1. Import the document wholesale. Fast, but replaces confirmed R02 behavior,
   narrows trusted auth without adapter evidence, and overstates closure.
2. Adopt compatible behaviors, isolate conflicts and remaining schema work.
   Preserves progress and authority boundaries, but requires a short maintained
   supplement and explicit follow-up on the real gaps.
3. Reopen every architecture question. Avoids relying on the supplement, but
   duplicates accepted choices and delays contract work without clear benefit.

Recommend and adopt option 2 for the compatible content under the user's
reference-and-confirm request. Conflicting proposals are not deemed confirmed.

## Decision

[V1_CONTRACTS.md](../architecture/V1_CONTRACTS.md) owns the detailed C01-C10
selections. Adopt C01-C08 directions: matched reply/resume, immutable approval
decisions and consumable grants, Run route binding and credential attempts,
small-window-aware budgets, unified attempt accounting, separate execution/
evidence/delivery/verification, conservative UTC search reservations, and
Session-owned LSP lifecycle.

Adopt compatible configuration transaction and streaming-egress details in
C09/C10. Preserve ADR-0003 non-Shell persistent exceptions and final-merge
filtering; preserve ADR-0004's intended-Provider trusted authentication path.
Do not adopt a universal eight-character key minimum or an Authorization-only
authentication exception. Exact auth slots and representation support need
review. Remaining sensitive-context redisclosure semantics must be settled
before affected implementation.

C04 supersedes the baseline's universal fixed 16k/15% reserve. C02 refines
invalidation by revoking a grant without changing an approved historical
decision. C01 supersedes blanket extra ResumeRun for approval/question replies;
configuration/recovery still require explicit resume.

## Impact

Coordinator, event writer, permissions, Providers, context, process supervision,
search accounting, credential boundaries, and TUI share these contracts.
Keep modelRequestId/attemptNo and canonical precondition hashes consistent;
do not create a new subsystem for each illustrative source type.

Event-derived grants reduce mutable authority but add replay/race-test cost.
Conservative reservations may overcount after crashes; this is preferred to
unreserved paid requests. Run-fixed routing simplifies recovery at the cost of
requiring a new Run for immediate model changes. Egress buffering adds memory/
latency and must be bounded without releasing protected prefixes.

The source's sketches are not final executable schemas. G01-G10 remain OPEN.
No runtime code, scaffolding, dependency installation, Git operations, real
credentials, paid calls, or native tests are authorized.

## Reassessment

Revisit affected decisions if Provider limits/authentication invalidate the
budget/adapter contract, Windows durability/supervision cannot meet gates, safe
stream buffering is infeasible, quota crash semantics are unacceptable, or
approved multi-Agent/remote/sandbox scope changes ownership/concurrency.
Any change in authorization or disclosure policy requires user confirmation.
