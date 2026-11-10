# ADR-0028: Per-Run Model Binding And Attempt-Level Credential Revision

- Status: Confirmed implementation of already-confirmed C03 / ADR-0008 design
- Date: 2026-11-05
- Related: V1_CONTRACTS.md C03; ADR-0008; V1_BASELINE.md section 6

## Context

C03 says a Run's provider, model, protocol and endpoint are fixed when the Run
starts, and that each attempt binds a credential reference and revision at the
next not-yet-sent attempt. ADR-0008 adds that after a credential-account identity
change, already-read sensitive context needs explicit user agreement before
redisclosure.

None of this existed. A Run had no route identity at all, and there was no place
to record which credential revision an attempt used, so "which account saw this
content" was unanswerable.

## Decision

### Route binding

`domain/model-request/run-binding.ts` defines `RunModelBinding`: provider, model,
protocol, adapter version, endpoint, endpoint fingerprint, catalog and capability
snapshot identities, and the credential reference/revision.

`RuntimeCoordinator` accepts an optional `runBinding` and writes exactly one
`run_model_binding` event at Run start. Absent, no event is written, so current
callers are unaffected.

### Endpoint fingerprint

`describeEndpoint` keeps only scheme, host (lowercased), port and path. Query
strings, fragments and userinfo are rejected outright, not stripped silently.

This is deliberately lossy and worth naming: two endpoints differing only by a
query parameter share a fingerprint. Query strings routinely carry API keys or
tenant ids, and persisting them into an event would be a worse failure than a
lossy fingerprint. The fingerprint is explicitly **not** the C03 final-request
fingerprint; it identifies a destination, not a request.

### Credential revision per attempt

`completeWithBoundedRetries` calls an optional `resolveCredentialRevision` once
per attempt, and the coordinator validates it with `bindAttempt` before recording
`model_request_started`:

- a **revision advance** for the same reference is allowed, because that is a
  rotation and the next unsent attempt is exactly where it must apply;
- a **different reference** is refused as `credential_identity_changed`, because
  that is a different account, not a rotation;
- a **throwing resolver** is refused as `credential_binding_failed`;
- any refusal happens **before** the provider call, so nothing is sent.

`onRequestStarted` now returns `{ ok } | { ok: false, safeCode }` instead of
`void`. That shape exists because the alternative was to throw, and a throw from
this callback would have surfaced through `#loop`'s catch-all as
`unexpected_internal_error` — which reads as a crash rather than the deliberate
pre-send refusal it actually is.

### Disclosure consent

`decideDisclosure` returns the ADR-0008 decision for a set of sensitive sources:

| Condition | Result |
| --- | --- |
| no consent | `no_consent` |
| provider/model/endpoint changed | `destination_changed` |
| credential **reference** changed | `credential_identity_changed` |
| a requested source was not covered | `source_not_covered` with the missing ids |
| otherwise | allowed |

`formatDisclosurePreview` shows destination, reference, revision and the covered
source ids, with no secret value and no full fingerprint.

## Deliberate Limits

- A **revision advance for the same reference is not treated as a consent
  boundary.** ADR-0008 warns that a new credential identity may represent a
  different account. Whether a same-reference revision bump can rotate the
  underlying account is a vendor property this project has not verified, so the
  conservative choice available here was to make the **reference** the identity
  boundary and document that a same-reference revision is not re-consented. If a
  vendor is later shown to change accounts behind a stable reference, this must
  become stricter; it must not be assumed correct today.
- `decideDisclosure` is pure policy. Nothing calls it from the coordinator yet,
  because there is no sensitive-context provenance tracking and no disclosure
  wait state. Wiring it without provenance would create a function that appears
  to protect content it cannot identify.
- No `run_model_binding` event is emitted by the demo runtime, since it passes no
  binding.

## Consequences

- "Which route and which credential revision handled this attempt" is now a
  recorded fact, not an inference.
- Existing behaviour is unchanged for callers that pass no binding and no
  resolver; both are optional for that reason.
- The refusal paths are proven by tests rather than described: a zero revision
  and a throwing resolver each leave `provider.requests` empty.

## Reassessment Conditions

Revisit the same-reference revision rule if a vendor is shown to bind different
accounts to one reference. Wire `decideDisclosure` only together with real
sensitive-source provenance and a disclosure wait, and revisit then.
