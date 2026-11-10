# ADR-0015: Adopt V1 Product Evaluation And Release Criteria

- Status: Confirmed design
- Date: 2026-10-31
- Owner: [V1_EVALUATION_AND_RELEASE.md](../architecture/V1_EVALUATION_AND_RELEASE.md)
- Related: V1_BASELINE sections 10-11; V1_CONTRACTS C04-C06; ADR-0014

## Context And Explicit Confirmation

The existing architecture specifies controlled execution, evidence, recovery
and engineering gates. It does not by itself demonstrate that the intended
developer can complete representative coding work or that later optimization
preserves product quality.

The assistant presented
`docs-check/V1_EVALUATION_AND_RELEASE_REVIEW.md`, summarized its twelve task
families and numerical release criteria, and explicitly asked whether to
adopt the whole proposal including those values. The user replied “可以”.
This adopts the whole presented evaluation design, including the counts and
thresholds. It is documentation/design confirmation, not coding authority.

The accepted pre-adoption source was 21,285 bytes, SHA-256:

```text
DD0AE47DA577CEE1DB2940588884CB36F0D652514C47AE4207C189C72BED4CC1
```

The owner above replaces that pending file. Status, relative links and
proposal wording are reconciled without changing the accepted behavior.
There is no duplicate confirmed copy in `docs-check/`.

## Decision

Adopt independent task verifiers and separate lifecycle, task/interaction
outcome, process compliance, and evidence/report assessment. Coding tasks
E01-E06 check fixes, features, refactors, test quality, unfamiliar projects
and Windows file details. E07-E12 check denial/clarification, changed input,
compaction, interruption/evidence loss, background cancellation and settings/
credential correction.

Each selected quality configuration has three independent samples per task:
36 total. Coding quality requires at least 15/18 passes; interaction quality
requires at least 16/18; every task family requires at least 2/3. These are
separate requirements, not one combined score. Violations of existing
mandatory rules or false verification claims block release and cannot use
the allowed quality-failure margin.

All applicable deterministic regressions, G01-G10, existing DoD and platform
requirements remain independent prerequisites. Product scores cannot replace
native/process/provider evidence or silently reduce V1 scope. Distinguish
adapter compatibility coverage from measured task quality for a particular
model/configuration.

Use frozen initial states, independent reset samples, versioned verifiers,
interaction/fault scripts and local evidence packages. Preserve blocked,
failed, unknown and unrun results; do not select the best retry or remove
failures to inflate a score. Prefer deterministic checks with explicit human
rubrics for remaining dimensions. No new LLM judge, default telemetry,
runtime self-modification or automatic release service is adopted.

Detailed cases, statistics, evidence contents and authorization boundaries
are maintained in the owner rather than copied into Runtime schemas.

## Evidence And Alternatives

The owner's book mapping records previously checked local sections: 7.2-7.5
and 7.7-7.8 for repeatable evaluation, process-aware independent verification,
regression and comparison; 2.7 for compaction quality; and 7.10/9.3 for reviewed
version promotion and rollback. This is not a new complete book review.
The numerical thresholds are this project's accepted choice, not prescriptions
from the book or proof of parity with any reference product.

Alternatives included using only deterministic Runtime tests, relying on model
completion claims, combining all outcomes into one score, or postponing numeric
targets until fixtures exist. The selected design adds realistic product
tasks and explicit modest initial thresholds while retaining independent
engineering gates. It costs more to curate/reset tasks and repeat sampling;
three samples per family are still insufficient for strong reliability claims.

## Remaining Work And Authority

Still needed: concrete fixture/verifier specifications and their positive/
negative controls, requirement-RT-G coverage, sampling branches/configuration,
report format, first Provider/model choice and separately approved real-test
budget. No fixtures, test engineering or product evaluations were created or
run by this decision.

The other newly discussed topics, including independent Skills scope and
full Prompt-template management, are not adopted by implication. Executable
contract schemas, catalog/SDK evidence and all G01-G10 remain open.
No coding, dependency installation, Git operation, real credential access,
paid request, native probe or real tool activation is authorized.

Subsequent decision: [ADR-0016](0016-remaining-design-and-fixture-specifications.md)
separately confirms the concrete fixture/control/branch/report specifications
and the presented prompt/compaction/Skills/diagnostic/TUI designs. This
updates the remaining-work status without attributing them to ADR-0015.
Executable assets, schemas, evidence and engineering gates remain open.

## Reassessment

If fixtures expose ambiguity, leakage, verifier defects or inadequate task
coverage, version the affected assets and preserve the original records.
Changed scoring rules or release thresholds require explicit user review;
re-evaluate both sides of a comparison under the same accepted rules.
Candidate improvements must not weaken permissions, audit history or unknown-
outcome protection, or redefine their own success criteria.
