# ADR-0017: Non-Send Correction And Verification Applicability

- Status: Confirmed design; documentation only
- Date: 2026-11-01
- Owners: [V1_CONTRACTS.md C07](../architecture/V1_CONTRACTS.md);
  [V1_DESIGN_SUPPLEMENTS.md S01 §6.3](../architecture/V1_DESIGN_SUPPLEMENTS.md)
- Related: ADR-0010, ADR-0015, ADR-0016; C02, C06, C07

## Context And Confirmation

The user limited this session to worthwhile architecture discussion/updates
without additional coding. After reviewing the book and reference projects,
the presented recommendation was to allow strictly evidenced non-send quota
correction and apply conservative version-applicability rules to verification.
The user replied “可以”, confirming these two directions and documentation
adoption, not implementation or adoption of whole pending Schema resources.

The revision-2 registry draft disallows dispatchEventId on not_sent_verified.
That over-restricts a case where dispatch intent was committed but reliable
evidence establishes non-send. Existing S01 also needs a concrete conservative
default for deciding whether a historical check still covers current code.

## Decision

Adopt the C07 non-send correction boundary in its owning document: dispatch
intent alone neither proves send nor bars correction. Complete durable
causal evidence, controlled pre-send recording, exclusion of a later send by
the original owner, and an explicit user correction are jointly necessary.
Unknowns retain quota and charge uncertainty; no automatic replay, refund or
rewriting of immutable execution outcomes follows.

Adopt S01 §6.3: historical check results remain facts, while applicability to
the current version is evaluated separately. Code/test/dependency/build
changes invalidate project-level reuse by default. Explicit narrow evidence
may establish that an unrelated change does not affect a particular claim.
Unknown change scope and observed interference prevent an unsupported current
verification claim. V1 adds no complex impact-analysis engine or isolation
promise, and invalidation grants no permission to rerun a command.

Detailed rules have one owner each above; this ADR records their rationale
and adoption rather than a second maintained rule table.

## Evidence And Alternatives

The read-only discussion and its source identities are recorded in
[the reference evidence addendum](../architecture/REFERENCE_EVIDENCE_20261031.md).
The book's p.76 append-only evidence/derived-state distinction, pp.126–128
failure classification and bounded recovery, p.199 exact-chain and regression
methods, and pp.264–266 independent verification/negative-result preservation
support these principles. They do not prescribe this project's exact ledger,
proof format or applicability algorithm.

Locked OpenCode compaction assertions and Miyu command-output/fixture paths
illustrate separate state, output and validation concerns; they do not
establish a verified non-send recovery protocol. The local Claude 2.1.88
snapshot checks stale read state/content before edits; borrowing the
freshness principle does not claim that it implements this verification
system or that the snapshot's official provenance is verified.

Always rejecting correction after dispatch is simpler but confuses intent
with network send and can strand provably unused quota. Releasing quota on
missing responses/log entries risks undercounting and duplicate paid sends.
The selected proof requirement accepts conservative quota loss when evidence
is insufficient. Blanket retention of old test conclusions risks false
verification; a full impact-analysis engine would add unsupported V1 scope.
The conservative default costs additional approved verification work.

## Remaining Deliverables And Reassessment

Reconcile pending registry proof shapes, the dispatch prohibition and N302,
cross-log ownership/order checks, and report version/observation expressions.
Preserved revision-2 JSON and structural cases are historical proposals, not
an executable expression of this decision. This adoption does not revise
their IDs or turn old structural QA into semantic acceptance. A later
serialization revision requires its own identity and review.

Future contract fixtures must cover correction before/after dispatch with
proof, missing/corrupt evidence, a live old sender, actual possibly_sent
crossing, and preserving immutable outcomes; and cover related/unrelated/
unknown changes, test/config/dependency changes and in-test interference.
These are required future checks, not implemented or executed tests.

Reopen the affected decision if SDK egress behavior, crash recovery or
platform observations cannot establish its proof boundary, or if a later
version proposes broader impact analysis. All G01–G10 remain OPEN and
RT-01–53 remain unexecuted. No feature code, dependency installation, Git
operation, real credential access, paid request or native test is authorized.
