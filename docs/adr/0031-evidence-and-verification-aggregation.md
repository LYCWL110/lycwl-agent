# ADR-0031: Typed Evidence References And Conservative Verification Aggregation

- Status: Confirmed implementation of already-confirmed S01 / C06 design
- Date: 2026-11-05
- Related: V1_DESIGN_SUPPLEMENTS.md S01; V1_CONTRACTS.md C06; ADR-0017

## Context

C06 separates execution outcome, evidence completeness, result delivery and task
verification. S01 specifies how evidence is located, how a report is shaped, and
how a policy status is aggregated from assertions.

None of it existed. There was no way to express "this claim is backed by these
exact lines of this exact snapshot", and no aggregation rule, so any
"verification" would have been prose.

## Decision

### Evidence references (`domain/evidence/evidence-ref.ts`)

Five mutually exclusive forms: `event`, `attachment_bytes`, `file_lines`,
`whole_file`, `background_stream`.

Mutual exclusivity is the point. The earlier proposal allowed a `file` kind with
an optional range, which made "I read something in that file" indistinguishable
from "I read these exact lines of this snapshot". That ambiguity is exactly what
lets an unverified claim look sourced.

Structural rules worth naming:

- file lines are 1-based and inclusive; a zero or negative start is rejected, and
  an inverted range is rejected rather than normalized;
- an empty file is expressed as `whole_file`, never as a degenerate line range;
- `whole_file` requires `captureComplete`; a truncated capture cannot claim the
  whole file;
- an attachment range must satisfy `0 <= start <= end <= byteLength`;
- a file reference is bound to a snapshot id **and** hash, so an old pass cannot
  silently attach to a newer file version.

`hasSubstantiveEvidence` treats an empty byte range as non-substantive: the range
is legal but proves no content was read. A reference existing is not evidence
being usable, which is why `UnavailableEvidence` keeps missing attachments, hash
mismatches, truncated captures and non-stored blocked content as first-class
records rather than dropping them.

### Aggregation (`domain/evidence/verification.ts`)

Order of precedence:

1. an applicable failure wins, and blockers are still reported alongside it;
2. `blocked` when a required check was denied, required evidence is missing,
   scope is indeterminate, or a required check did not run;
3. `verified` only when every required assertion passes with current-or-unaffected
   applicability, substantive evidence, no unavailable evidence and no blockers;
4. `partially_verified` when some required goal is positively verified and some
   is not;
5. `unverified` when there is no independent positive evidence.

A stale failure does not count as a current failure, and a later pass at the
current version is not permanently overridden by an earlier failure. Both
directions of that rule matter, and both are tested.

`modelClaimAsAssertion` exists so callers cannot forget: a model assessment is
always an unrequired claim with no evidence, never proof. No LLM judge is added.

### Version applicability (S01 6.3)

`reassessApplicability` marks a result `stale` after an unproven change and
`indeterminate` when the change scope is unknown. It becomes `unaffected` only
when the caller supplies `provenUnrelated: true` — a fact, not an inference. A
model explanation or a cache hit cannot fill that field. No test-impact-analysis
or dependency-graph engine is introduced.

### Report snapshot

`buildReportSnapshot` binds identity, source high-water seq, projection and
generator versions, the view, assertions, changes, tests, unknown side effects,
background tasks, the wait with its specific required action, usage including
unknown charge count, and evidence availability.

Run status is deliberately absent: Run state is independent, and a verification
view must not overwrite a cancelled or failed Run. Rebuilding for the same
high-water seq recomputes the aggregate from assertions instead of carrying a
status, so unknown items cannot become successes on rebuild. `renderReport`
always prints blockers and unknown charges, so a summary cannot look clean by
omission.

## Defect Found While Testing

My first aggregation recorded a `not_run_required` blocker but still returned
`unverified` instead of `blocked`, because the blocker list and the status check
disagreed. The test caught the contradiction: a report that lists a blocker while
claiming merely "unverified" understates a known gap.

## What This Is Not

- No coordinator wiring, no `TaskReportSnapshot` persistence, no attachment store.
- Structural validation is not semantic correctness. A `verified` report means the
  evidence supports the recorded assertions; it does not mean the code is good.
- Serialization schemas and positive/negative examples remain S03 work.

## Reassessment Conditions

Revisit the optional-assertion rule only with a concrete case where a
non-required check must block. Wire the report only together with real evidence
production, so a report cannot cite attachments the Harness does not keep.
