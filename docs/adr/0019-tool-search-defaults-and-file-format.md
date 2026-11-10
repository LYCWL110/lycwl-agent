# ADR-0019: Tool Search Defaults And File Format

- Status: Confirmed design; documentation only
- Date: 2026-11-01
- Owner: [V1_BEHAVIOR_CONTRACTS.md sections 2.1/2.2/3.1](../architecture/V1_BEHAVIOR_CONTRACTS.md)
- Related: ADR-0010–0012, ADR-0014; G02/G05/G06/G08

## Context And Confirmation

The user requested continued architecture discussion using the book, locked
OpenCode/Miyu revisions and the local Claude snapshot, without extra coding.
The last proposal presented four groups: search scope/completeness, initial
search defaults/limits, background default timeout and file-format behavior.
The user replied “可以”. Adopt those four groups; do not adopt all parameters
in the pending layered-tool Schema.

## Decision And Maintained Owner

The behavior document section 2.1 owns workspace-root defaults, supported
workspace ignore handling, hidden-file treatment, no automatic reparse-directory
recursion, permission checks before content reads, and distinct completeness
claims. It also owns list/glob/grep initial limits, stable path ordering,
case sensitivity, literal-by-default grep and explicit regex selection.

Section 2.2 owns the 600-second background default with the previously selected
1800-second maximum, previewing the normalized value and retaining existing
termination/unknown-outcome rules. Section 3.1 owns UTF-8/no-BOM/LF new-file
defaults, preservation for existing files, ambiguous mixed-ending choices,
unrepresentable-character failure and separately approved conversion.
These are initial design settings, not measured optimums or passed tests.

The former Runtime paragraph explicitly defined new-file
`lineEnding="preserve"` as retaining supplied content's newline sequences.
This was a real earlier definition. The later confirmed explicit-format
decision supersedes that behavior and the draft's preserve default.
Keep historical records; the exact legacy field migration/rejection still
requires review, without silently treating preserve as LF.

## Evidence, Alternatives And Tradeoffs

The preceding read-only checks and file identities are recorded in
[reference evidence section 8](../architecture/REFERENCE_EVIDENCE_20261031.md).
OpenCode's inspected grep/glob paths distinguish bounded results and
truncation, but their regex/hidden defaults are not imported. Miyu's grep
descriptor explains scope and limits; a descriptor does not prove runtime
permission enforcement or completeness. The local Claude paths show bounded
search presentation and existing/new-file distinctions. They do not establish
this Harness's exact format or permission behavior; official provenance of
the snapshot remains unverified.

The already-read book p.199 supports inspecting the byte-to-tool-to-context
matching chain and end-to-end/prefix regressions. It does not prescribe these
numeric defaults, regex engine or newline policy. No PDF extraction or
reference-project execution was repeated for this documentation adoption.

Regex-by-default is compact for experienced callers but creates unintended
pattern interpretation; literal default with explicit regex makes that choice
visible. Hidden-file exclusion is convenient but can hide relevant project
files; explicit ignore rules with prior permission checks make the scope
explainable. Modification-time ordering is useful for recency but less stable.
Keeping only a truncated flag is smaller but conflates unsearched scope with a
bounded result set. New-file input-preserve and neighbor-based guessing can
retain accidental or inconsistent formats; explicit defaults are predictable,
while existing-file preservation avoids unrelated rewrites.
The selected choices require more precise facts, format checks and fixtures.

## Remaining Work And Reassessment

Regex dialect/engine/dependency, supported ignore syntax/parser compatibility,
depth-zero semantics, comparator/traversal/counting details, fields and legacy
format reconciliation remain executable-contract work. Todo and remaining
Shell/background/Web field limits not presented in these four groups remain
pending. Supported write encodings are not expanded by this decision.

The layered-tool draft still hard-codes rust-regex and defaults new-file
lineEnding to preserve, lacks sufficient scope/skip facts and does not fully
express grep ignore behavior. Mark these differences for revision; preserve
all fenced JSON bodies and resource IDs in this adoption.
Numeric agreement alone does not confirm an entire Schema or structural case.

Future acceptance must cover ignored/hidden/sensitive/outside/reparse paths,
complete no-match versus unsearched/truncated/timeout/cancel results, literal
and invalid regex requests, separate matching/context counts, normalized
timeout previews and termination, BOM/encoding/mixed-ending preservation,
unrepresentable characters and explicit conversion. These are requirements,
not tests run here. Reassess if implementation/platform evidence conflicts
with these semantics or a proposal changes their user-visible behavior.

G01–G10 remain OPEN; RT-01–53 remain unexecuted. No feature coding, dependency
installation, Git operation, paid/model request or tool activation is authorized.
