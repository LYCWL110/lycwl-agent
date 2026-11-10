# ADR-0001: Consolidate The V1 Architecture Baseline

Date: 2026-10-30.
Status: accepted for the consistent decisions described below. R01-R03 were
subsequently resolved in [ADR-0002](0002-search-authentication.md),
[ADR-0003](0003-non-shell-environment.md), and
[ADR-0004](0004-owned-key-exit-guard.md).
Engineering validation is pending. This is not coding authorization.

Follow-up: [ADR-0005](0005-runtime-contracts.md) records the compatible contract
supplement, including supersession of the fixed context reserve and refinement
of reply/resume and approval-grant behavior. This ADR retains the original
consolidation rationale; current detailed behavior is in V1_CONTRACTS.md.

## Problem

AGENTS.md established many architectural constraints but left schemas, budgets,
module layout, platform integration, and delivery choices open. The user
provided three local design documents and requested using them to confirm
previously unconfirmed questions. Leaving them outside the project would allow
later Agents to repeat resolved discussions or inherit contradictory defaults.

## Basis And Constraints

Use the existing confirmed decisions and permissions first. Read the supplied
texts, distinguish their design suggestions from evidence, recheck time-varying
claims, and never equate another assistant's "locked" label with tested software.
Source identities and hashes are in
[BASELINE_REVIEW.md](../architecture/BASELINE_REVIEW.md).

The book references previously recorded in AGENTS.md motivate durable logs,
checkpoints, failure classification, and bounded trajectory use. This ADR does
not claim the book specifies our schemas, FFI library, or numeric budgets.

## Candidates

1. Keep all pending questions and discuss every value again. Low import risk,
   but repeats the user's design work and delays a coherent baseline.
2. Copy the supplied final/checklist wholesale and mark every decision closed.
   Fast, but imports a Node release-date error, ambiguous authentication scope,
   incomplete contracts, and unverified "final" assertions.
3. Adopt consistent designs into one project baseline, preserve security rules,
   separate actual decision gaps from engineering gates, and record corrections.

## Tradeoffs

Candidate 3 costs an explicit mapping/review pass but avoids both redundant
selection and false certainty. Serial sibling tools simplify correctness at the
cost of performance. Koffi/Job Objects adds native lifecycle/packaging risk but
avoids declaring best-effort process cleanup equivalent to the required
supervision. Modular ports preserve future Agent evolution without implementing
a speculative multi-Agent framework.

## Recommendation

Choose candidate 3. Store detailed architecture outside AGENTS.md; keep the
latter executable as repository rules and cross-reference the baseline.
Native-process, vault, network, and recovery routes require real tests before
any availability/safety claims.

## Confirmation

The current user request authorizes applying the supplied materials to resolve
earlier open architecture items. Record the selected scope, layering, Runtime,
serial scheduling, model/context/persistence strategy, TUI/toolchain, numeric
defaults, retention, and delivery direction in
[V1_BASELINE.md](../architecture/V1_BASELINE.md).

At consolidation, R01 (search Basic-auth exception), R02 (non-Shell credential
exceptions), and R03 (owned-key exit enforcement) required separate explicit
confirmation. R01 was subsequently confirmed and is governed by ADR-0002.
R02 was subsequently confirmed in ADR-0003, adding persistent user-managed
non-Shell configuration exceptions to the shared final-environment policy.
Default filtering remains. R03 was subsequently confirmed in ADR-0004 as
access boundaries, field/header redaction, and exact registered-owned-key exit
blocking. Contract closure and all engineering gates remain pending.

## Impact

AGENTS.md now separates selected architecture, remaining decisions, contract
closure, and G01-G10 implementation gates. The full Miyu commit is recorded,
the Node patch/date mistake is corrected, and unavailable historical Provider
catalogs are not fabricated. Native binaries are allowed only as reviewed
third-party dependencies; application source remains TypeScript.

## Reassessment

Reopen the affected decision if Windows FFI/Job/pipe tests fail, supported
Providers cannot meet the matrix contract, vendor terms/authentication conflict
with requirements, small context windows cannot meet protected-state budgets,
or multi-Agent/remote/sandbox requirements become real. Explain migration,
compatibility, safety, and tests before changing the baseline.

## Execution Status

Only Markdown documents changed. No feature implementation, dependency install,
Git initialization/commit, paid API call, or Windows native execution test.
