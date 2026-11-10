# ADR-0070: Frozen Reasoning Reference Fallback

- Date: 2026-11-07
- Status: Confirmed and implementation authorized by the user's "可以" after
  the OpenCode source review and fallback proposal
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE section 6
- Related: ADR-0068/0069; V1_CONTRACTS C03

Superseded for selectable reference values and manual mode by
[ADR-0071](0071-declared-reasoning-choices-only.md), following the user's request
to hide unverified choices. The decision and evidence below describe history.

## Context And Evidence

The configured relay may publish model identifiers without effort declarations.
List/detail lookups cannot obtain information absent from those responses.
[The source review](../reviews/OPENCODE_REASONING_SOURCE_REVIEW_20261107.md)
records the pinned OpenCode catalog-to-variant-to-TUI path and exact source hashes.
The user approved the proposed fixed-reference fallback.

## Decision

S02 owns selection precedence, identity matching, evidence labels, invalidation
and save rules. Bundle a small immutable projection of explicit native effort
arrays and protocol availability from the reviewed snapshot. The initial
projection covers active OpenAI, Anthropic and DeepSeek catalog records with
explicit effort arrays; it is not the full Provider compatibility matrix.

Explicit upstream declarations, including empty arrays, take precedence.
Absent declarations permit exact reference matching; otherwise retain explicit
manual selection for unknown models. Malformed/conflicting recognized metadata
blocks reference fallback, preserving unknown status rather than broadening
the upstream response.

Reference options are labelled unverified for the configured relay. Do not use
substring/family matching, invented aliases or cross-protocol substitution.
Provider-qualified catalog IDs and unique exact bare IDs may match; the actual
request model ID is never rewritten. No catalog refresh, provider-key disclosure
to catalog hosts or generation probe is introduced. Reference availability does
not suppress ordinary selected-model metadata lookup.

Only native effort values are imported. OpenCode's thinking-toggle and
token-budget variants do not become effort values, and effort selection adds no
automatic thinking enablement/budget. Existing request mapping and next-Run
configuration binding remain unchanged.

## Alternatives And Consequences

Keeping unknown/default-only behavior leaves known models without convenient
choices on basic relays. Automatic probing costs requests and cannot prove
effective execution; family-name guessing misidentifies aliases and versions.
The confirmed reference approach offers known values with explicit uncertainty,
at the cost of a deliberately bounded, frozen catalog.

This supersedes ADR-0068/0069's default-only behavior only for exact reference
matches with no invalid/explicit upstream declaration. Source hashes,
projection rules and local validation are recorded in the source review.
Actual relay acceptance/effectiveness and full G01/G08 acceptance remain open.

## Discoverability Correction

The user's follow-up still seeing only Default exposed a gap in manual-mode
discoverability. The locally saved model/protocol did not match the reference
projection. The Reasoning column now includes an explicit `Manual...` command
for unknown models, in addition to `m`. Enter on that command opts into the
existing unverified manual mode without saving; a separate selection/Enter
saves. This does not broaden upstream restrictions, infer aliases or add
cross-protocol reference claims.
