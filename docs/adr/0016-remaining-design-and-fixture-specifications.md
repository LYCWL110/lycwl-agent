# ADR-0016: Adopt Remaining Design And Evaluation Fixture Specifications

- Status: Confirmed design
- Date: 2026-10-31
- Owners: [V1_DESIGN_SUPPLEMENTS.md](../architecture/V1_DESIGN_SUPPLEMENTS.md);
  [V1_EVALUATION_FIXTURES.md](../architecture/V1_EVALUATION_FIXTURES.md)
- Related: ADR-0013–0015; V1_CONTRACTS C03–C06; V1_BASELINE sections 6–11

## Context And Explicit Confirmation

The user requested completion of the previously unfinished design using the
locked OpenCode and Miyu revisions, the book and the local Claude source
snapshot. The presented package covered P01–P05 and S01–S03, concrete E01–E12
fixture/verifier specifications, and explicitly recommended Skills option B
with its scope and initial limits. The user replied “可以”.

This confirms that complete presented package, including minimal workspace
document Skills and the limits. No second approval is needed to record these
choices. This is design/documentation adoption, not implementation authority.

The exact pre-adoption source identities are:

| Original path | Bytes | SHA-256 |
| --- | --- | --- |
| `docs-check/V1_REMAINING_DESIGN_REVIEW.md` | 31,035 | `79a64911dd727e0a55ae411824e05c495a87b6ba05925f21361407a45bba4286` |
| `docs-check/V1_EVALUATION_FIXTURES_REVIEW.md` | 18,322 | `0bc4e6a773b8290dd8808a191e981dd75acaee4e5bcbf7523eac1fd5d4441aaa` |

The owners replace these pending files. Status, relative links and proposal
wording are reconciled; no duplicate confirmed copy remains in docs-check.

## Decision

Adopt release-bundled, version-bound trusted templates and deterministic
rendering with explicit inputs/provenance, synthetic snapshots and regression
requirements. Template hashes do not replace C03 final-request fingerprints.

Adopt P02's foreground bounded compaction construction: atomic complete
response/call/result groups, source closure, coverage skeleton before details,
deterministic bounded clipping, adapter-rendered budget checks, separate
auxiliary-request disclosure/binding and durable publication. Preserve C04/C05
formulas and attempt limits; insufficient capacity fails explicitly. References
and structural validation do not prove natural-language claims.

Adopt P03 option B: workspace document Skills, Session switch default off,
discovery only under `.agents/skills/<skillId>/SKILL.md`, 64 entries, 64 KiB
raw bytes per file and a 4096 estimated-token catalog also bounded by C04.
Use the specified restricted name/description metadata, versioned snapshots
and ordinary read_file for bodies. Skill content remains untrusted; selecting
it submits ordinary task input and grants no tool permission. No load_skill
tool, slash framework, installer, global/network discovery or execution
metadata is introduced.

Adopt metadata-first local diagnostics and explicitly scoped local exports,
synthetic-first failure assets, versioned optimization candidates, paired
comparisons, independent retained variants, manual promotion and compatible
rollback. Authoritative events and critical fail-closed paths remain distinct
from optional diagnostics. No full real-request recording, OTEL exporter,
default telemetry, runtime self-modification or automatic learning is selected.

Adopt S01's typed evidence locations, high-water report snapshots and
verification aggregation, including the applicability of tests to the tested
code version. Adopt S02's core TUI functional/state specification, including
the selected Skills switch/catalog. These are neither executable report
schemas nor a rendered or Windows-tested UI.

Adopt the concrete E01–E12 initial states, assertions, positive/negative
controls, frozen primary sampling branches, complementary deterministic
variants, D01–D06 RT partition and sample/report asset specifications.
ADR-0015's sample counts and release thresholds remain unchanged.

S03 is the remaining-deliverable register, not a claim of delivered schemas,
external evidence or completed gates.

## Evidence, Alternatives And Tradeoffs

[REFERENCE_EVIDENCE_20261031.md](../architecture/REFERENCE_EVIDENCE_20261031.md)
records locked OpenCode/Miyu source identities, inspected local Claude 2.1.88
paths and book sections/pages. Its observations support selected lessons,
not wholesale copying, test success or official provenance of the local
snapshot. No new reference retrieval or reference-project execution was
needed for this adoption.

Editable trusted templates would expand the configuration/trust surface.
Bundled templates constrain that surface at the cost of release-bound updates.
Skeleton-first compaction preserves explicit coverage but may fail on capacity
where a lossy heuristic would continue; no extra retry loop is accepted.
Skills option A was smaller but lacked discoverability; option C added global
installation and executable ecosystem scope beyond V1. Option B retains
progressive document loading with normal permission boundaries and explicit caps.
Metadata-first diagnostics provide less raw debugging context while reducing
default private-content copying. Independent verifiers and retained comparison
variants cost curation effort and do not eliminate semantic uncertainty.

## Remaining Deliverables And Authority

Deliver layered executable Request/all-terminal Payload/Envelope/Command/Event
schemas, cross-record checks and positive/negative examples; prompt/context/
Skills/report/diagnostic and registry serialization; full catalog/auth/env/SDK/
fees/terms/dependency/JCS evidence; and actual fixture snapshots/hashes,
verifier implementations, scripts and run records. The first quality
Provider/model/parameters and paid-test budget remain unselected.

The old 24 JSON blocks remain historical pending serialization. RT-01–53 are
unexecuted; P/S regressions still need concrete test assets; G01–G10 remain
OPEN. This adoption authorizes no feature coding, dependencies, Git setup,
real credential access, paid requests, native probes or real tool activation.
Coding still requires explicit “开始编码” and current-stage authorization.

## Reassessment

If schema work exposes a genuine behavioral conflict, return that conflict
for decision rather than silently weakening accepted rules. Changes to Skills
scope/limits, trusted-template editability, compaction fallbacks, disclosure,
report meaning or release thresholds require explicit review. Version changed
fixtures/verifiers and preserve earlier failures and negative comparisons;
never rewrite execution facts, restore deleted credentials automatically or
make a candidate its own unchecked verifier.
