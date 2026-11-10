# ADR-0007: Provider Key Validation Without A Universal Minimum Length

Date: 2026-10-30.
Status: accepted by explicit user confirmation of the C10 length-policy proposal.
Documentation only; no feature implementation, real credential access, live
authentication test, or paid request is authorized.

## Problem And Constraints

The imported C10 proposes an eight-character minimum for all Provider keys.
That arbitrary global rule may reject a Provider-valid credential. Conversely,
skipping short values in exact exit checks would weaken accepted R03.
Separate admission validation from protected-exit matching.

Keep API-key-only model authentication, Credential Manager storage, the finite
registered-value guard, trusted intended-Provider authentication, and no general
secret scanner. No book passage is claimed to prescribe an eight-character
minimum; previously recorded failure/recovery principles do not determine key
formats.

## Reference Evidence

The preceding C10 discussion inspected these specific paths:

- OpenCode `7ab721a97f383b89a8d901c87866b1565c1cfd9c`,
  `packages/cli/src/commands/handlers/auth/form.ts:65`: the secret-input path
  checks nonempty input. This is not proof that every downstream adapter accepts
  every nonempty value.
- The same revision's `packages/http-recorder/src/redaction/secrets.ts:18`
  excludes environment values shorter than 12 characters from that recorder's
  environment-secret findings. This is a channel-specific detection threshold,
  not an admission rule or a universal protection guarantee.
- Miyu `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`,
  `src/config_tui/providers.rs:578`: trims input and filters an empty value on
  this save path, without an eight-character minimum in the inspected path.
- Local Claude Code 2.1.88 snapshot, `src/utils/auth.ts:1089`: checks a character
  pattern without an eight-character minimum in that function. The snapshot's
  official provenance remains unverified.

These observations distinguish input validation from output safeguards. They
do not establish complete reference security behavior, a verified short-key
Provider matrix, or our guard's correctness. No reference code was copied.

## Candidates And Tradeoffs

1. Require at least eight characters everywhere. Simple and reduces some common
   short-text matches, but lacks a universal Provider basis and does not prove
   credential security.
2. Validate under verified Provider/protocol rules, with no universal minimum,
   and keep exact registered-key protection independent of length. More
   compatible but can block ordinary content that happens to contain a short
   registered key.

Recommend candidate 2. The user answered "可以" to this recommendation,
including the stated false-positive cost and no-bypass recovery behavior.
Candidate 2 is accepted.

## Decision

[V1_CONTRACTS.md C10](../architecture/V1_CONTRACTS.md#c10-credentials-and-egress-confirmed-direction)
owns the detailed behavior: reject empty credentials; use verified adapter rules
without silently rewriting key values; apply exact registered matching to short
keys as well as long ones; warn about collisions without implying validity;
and fail closed with no original-output bypass or automatic side-effect replay.

The source's universal eight-character minimum is rejected, not merely awaiting
confirmation. This does not waive Provider-specific or transport/vault resource
limits, introduce keyless authentication, or prove a saved key works.
Legitimate intended-Provider authentication remains separately trusted; its
per-adapter slots still need review.

## Impact And Limitations

TUI, vault registration, Provider adapters, and egress handling must distinguish
input validity, stored/unverified status, and output match/block state. A literal
match can be incidental, so diagnostics must not assert that a leak definitely
occurred or print the matched value.

Very short/common keys may make a coding workflow unusable. The accepted
response is safe blocking and user remediation, not a hidden minimum, reduced
matching, or an override button. Even controlled diagnostics need verification
under short-key collisions; do not assume their ordinary wording is safe.
This selection adds no generic scanner, OS isolation, or zero-leak guarantee.

## Remaining Contracts And Acceptance

Finalize verified Provider constraints, warning behavior, finite representations,
registry lifetime/restart coverage, decoder/prefix buffering, safe diagnostic
fallbacks, and blocked-state schemas before affected implementation.

Under separate authorization, use synthetic keys of length 1, 7, 8, and ordinary
long lengths. Include a common-word value such as test, every chunk split,
substring matches inside longer words, safe output without matches, structured
logs/errors, raw attachments before persistence, and matcher failure.
Verify empty-key rejection and adapter-specific validation without silent
trimming or mutation. Verify incidental matches block without asserting certain
exfiltration, auth paths remain narrowly trusted, and tool-output blocking
preserves actual effects without retry.

These are proposed acceptance cases, not executed tests. G01-G10 remain OPEN.
Real credential validation and any paid request need separate permission.

## Reassessment

Reopen if supported Provider constraints conflict with this policy, collision
rates make the accepted workflow unsuitable, or exact checking cannot safely
cover the selected boundaries within budgets. Any relaxed matching or disclosure
override requires a new explicit user decision, not an implementation fallback.
