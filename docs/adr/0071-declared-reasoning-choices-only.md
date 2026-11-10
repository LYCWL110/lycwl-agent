# ADR-0071: Declared Reasoning Choices Only

- Date: 2026-11-07
- Status: Confirmed and authorized by the user's request to show only verified choices
- Owner: V1_DESIGN_SUPPLEMENTS S02
- Related: ADR-0068/0069/0070; V1_CONTRACTS C03

## Context

After seeing reference and manual values labelled unverified, the user requested
that unverified choices be hidden. The current implementation has upstream
list/detail declarations, not a live compatibility verification ledger.
A catalog record or successful parameter echo cannot prove effective reasoning.

## Decision

Remove reference fallback and manual mode from the selector. Only explicit
current-connection model/protocol declarations supply non-default choices.
Missing, malformed or conflicting declarations leave only default, which omits
the parameter. Label declarations as upstream declarations, never as tested
compatibility. There is no claim that any live level was verified.

S02 owns the detailed selection, invalidation and save behavior. Existing
next-Run binding, three-protocol mapping and bounded detail cache stay in place.
Saved values absent from declarations remain visible as unavailable and block
saving until an allowed value is explicitly chosen. Existing saved settings
are not automatically rewritten.

This supersedes ADR-0070's selectable reference fallback and manual affordances.
The frozen reference data and source review remain historical evidence; they
are no longer imported by the selector. No actual credential access, generation
probe, paid verification or new dependency is introduced by this change.

## Alternatives And Remaining Work

Keeping unverified values contradicts the latest display preference. An actual
verification-only catalog would need separately scoped live evidence and still
cannot infer effective execution from HTTP acceptance alone. This change instead
exposes only declared values and keeps that evidence boundary explicit.
Live relay support and G01/G08 acceptance remain unverified.
