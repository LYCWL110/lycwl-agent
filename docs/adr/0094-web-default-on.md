# ADR-0094: Web Tools On By Default With Vault-Backed Search Credentials

- Status: Accepted (2026-11-25)
- Related: ADR-0021 (web boundaries), ADR-0023 (Tavily), ADR-0090 (default permissions), ADR-0093 (catalog)

## Decision

`web_search` and `web_fetch` are wired and advertised by default. `--read-only`
is the explicit opt-out for writes, shell and network, so it passes
`enableWeb: false`; a caller can still enable web explicitly in a narrow build.

Default availability does not weaken the call boundary. Both tools keep
`sideEffectClass: "external_request"` and `requiresApproval: true`. The user sees
the final query or URL, the result count, the destination addresses and the paid
or external effect before anything is sent. Search keeps the C07 ledger
(10 calls per Run, 100 per UTC month) and fails closed on a corrupt ledger.

The search credential is read from the vault under the fixed reference
`search-main` with purpose `search_api_key`. `lycwl --search-key` prompts without
echo and writes the value through the vault; the secret never appears in argv,
output, events or the model context. `--setup` reports only whether the key is
configured. A missing key returns `search_backend_not_configured`; there is no
environment fallback, alternate vendor or guessed credential.

Quota identity comes from the coordinator-owned `request.owner`, not from the
tool executor's construction time. Otherwise the per-Run limit would be counted
against a fixed placeholder for the whole process lifetime.

## Consequences

A default launch can fetch a URL after approval, and can search after the user
stores a Tavily key. `web_fetch` works without any vendor credential; only
search needs one.

`--read-only` now means no network as well as no writes or processes. A user who
wants local tools plus web must pass an explicit `enableWeb: true` only through
an embedding caller; the CLI does not offer that combination.

The search key is added to the protected-key registry, so a model reply or tool
result that echoes it is blocked before delivery, like a provider key.

## Reassessment Conditions

Revisit if web access should be independent of `--read-only`, if a second search
vendor needs per-vendor references, or if provider-native search (ADR-0024) is
adopted. Any approval bypass would require a separate decision, not this one.
