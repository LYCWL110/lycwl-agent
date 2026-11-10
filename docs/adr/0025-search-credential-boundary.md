# ADR-0025: Search Credential Boundary And Reservation Ordering Fix

- Status: Confirmed implementation of already-confirmed policy; G03 remains unvalidated
- Date: 2026-11-05
- Related: ADR-0023, V1_CONTRACTS.md C07/C09/C10, V1_BASELINE.md section 8

## Context

The Tavily slice read `TAVILY_API_KEY` directly from `process.env` in the
composition root. That contradicted two confirmed rules:

- C10/ADR-0023: secrets live only in Windows Credential Manager; configuration,
  events, logs and previews carry a reference, never a value.
- The environment filter baseline removes `TAVILY_API_KEY` from child processes
  precisely because it is a credential, so reading it from the parent
  environment was also inconsistent with the project's own filtering model.

Two defects were found while making the change; both are behaviour, not style:

1. **A missing credential consumed quota.** The reservation was written before
   the key was checked. The original code hid this by checking the environment
   first, so the ordering flaw was invisible. With a vault resolver the ordering
   became observable: no key still wrote `reserved`, `possibly_sent` and
   `uncertain`, permanently burning a slot for a request that could never leave.
2. **The reservation identity used the query text.** `makeReservationId` was
   called with `toolCallId: request.query`, so two identical queries in one Run
   produced the same id and collided as a duplicate reservation.

## Decision

Introduce an explicit credential boundary and fix both defects.

### Boundary

- `src/ports/credential-vault.ts` owns the port: purpose-bound references,
  reference validation, and a resolver type. Secrets are `string` only at the
  single call site that uses them.
- Purposes are `provider_api_key` and `search_api_key`, and the vault target name
  is prefixed by purpose (`lycwl/search/...`, `lycwl/provider/...`). This is
  enforced in code, not by naming convention: a search reference cannot
  authenticate a Provider even if a caller supplies the right name.
- `src/adapters/windows/credential-manager-vault.ts` implements the confirmed
  route (Koffi -> `CredReadW` / `CredWriteW` / `CredDeleteW` / `CredFree`,
  generic credentials, `CRED_PERSIST_LOCAL_MACHINE`).
- The composition root takes `resolveSearchApiKey`; it no longer reads the
  environment. `tavilySearch` receives the already-resolved value so the key that
  authorized the reservation is the key that is sent.

### Ordering

The search path now resolves the credential **before** reserving quota:

1. no resolver composed -> `search_backend_not_configured`, no reservation;
2. resolver returns null or throws -> `search_backend_not_configured`, no
   reservation;
3. key present -> reserve, mark `possibly_sent`, send, then record
   `reported` or `uncertain`.

The reservation id is built from the real `toolCallId` together with session,
Run and query, so two identical queries are two distinct calls.

## G03 Gate

The adapter refuses all real vault access unless constructed with
`gateValidated: true`, returning `gate_not_validated`. G03 (Credential Manager
transactions) is **not** validated on this host:

- no real `CredReadW`/`CredWriteW`/`CredDeleteW` call was made;
- tests use an in-memory stand-in and the refusal path;
- `GetLastError` was initially bound from `advapi32.dll` and threw at import
  time; it belongs to `kernel32.dll`, and a wrong-module binding would have made
  the adapter unusable rather than merely failing closed.

No real Tavily request was made.

## Consequences

- The environment is no longer a credential source for search. Configuration and
  events carry a reference and revision only.
- Quota is spent only when a send is actually possible, which changes observable
  ledger contents for the no-key case. This is a correctness improvement, not a
  relaxation: the fail-closed property is preserved and strengthened.
- The search path still cannot run end to end on this host, because no vault
  entry exists and G03 is open. That is unchanged from before this ADR; what
  changed is that the reason is now an explicit gate rather than an environment
  lookup.

## Reassessment Conditions

Validate G03 before enabling `gateValidated: true`: confirm `CredReadW`/
`CredWriteW`/`CredDeleteW`/`CredFree` behaviour, the `CredentialBlob` decode
path and `CredFree` ownership on this Windows build, and confirm that a failed
write leaves no partial value. Until then the gate stays closed.
