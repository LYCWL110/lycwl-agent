# ADR-0002: Separate Search Authentication From Model Authentication

Date: 2026-10-30.
Status: accepted by explicit user confirmation of R01. Design only; no
implementation, dependency installation, account agreement, or paid use authorized.

## Problem

The selected DataForSEO Google Organic Live Advanced route uses API Access
login/password rather than one API key. Applying the earlier key-only scope to
every integration would conflict with this route. Define a narrow exception
without changing the supported model authentication modes.

## Evidence And Constraints

- DataForSEO's official Live Advanced documentation specifies API Access
  login/password encoded for HTTP Basic Authentication. The documentation was
  read without submitting a search or credentials:
  `https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/`.
- Locked OpenCode separates the search service and provider implementation:
  `packages/core/src/websearch.ts:35` and
  `packages/core/src/plugin/websearch/tavily.ts:48`. This supports separation
  of responsibilities, not a claim that OpenCode uses DataForSEO.
- Locked Miyu separates API search implementations and supports fallback:
  `crates/miyu-engine/src/tools/web/api_search.rs` and `web/mod.rs:115`.
  Its automatic fallback is not adopted.
- Local Claude snapshot `src/tools/WebSearchTool/WebSearchTool.ts:268`
  invokes model-hosted search through a model request. Its official source
  provenance remains unverified; the Harness does not adopt that coupling.
- Reference identities and evidence limitations are maintained in AGENTS.md
  and BASELINE_REVIEW.md. No book passage is claimed to prescribe a vendor or
  this authentication exception.

## Candidates And Tradeoffs

1. Require a single API key for all integrations. Uniform configuration, but
   requires rejecting the selected backend and evaluating an alternative.
2. Permit separate search authentication while models remain API-key-only.
   Preserves provider-independent search, at the cost of another credential
   contract, TUI flow, and validation surface.
3. Use model-hosted search. May reuse model authentication, but ties search
   availability, query behavior, and accounting to model-provider capabilities;
   it is not equivalent to the confirmed exact-query approval contract.

## Recommendation And Confirmed Decision

Choose candidate 2. The user answered "可以" to the explicit R01 confirmation
question after reviewing the recommendations. This confirms R01 only, not the
R02/R03 recommendations presented alongside it.

Select DataForSEO Google Organic Live Advanced with separate API Access
login/password over HTTPS Basic Authentication. Model Providers continue to
accept user-supplied API keys only. The search exception grants no OAuth,
browser/CLI login, ambient identity, or child-process credential exception.

Use separate TUI search settings and separate Credential Manager references.
The maintained storage, approval, budget, retry, and disclosure rules are in
V1_BASELINE.md section 8; this ADR does not create a parallel configuration.
Do not send search credentials in model context or diagnostics.

## Impact

The search adapter and configuration contracts must distinguish model keys
from search credentials. Preserve exact-query one-shot approval, bounded
request counts, no automatic recharge, and no automatic resubmission after an
uncertain charged request. Do not introduce automatic provider fallback or
model-mediated query rewriting under this decision.

All G01-G10 gates remain open. In particular, G10 must review actual usage,
vendor terms, query disclosure, and result retention rights before real use.
Authentication acceptance is neither a legal finding nor a guarantee of fees,
availability, storage, redistribution, or training rights. R02 was subsequently
resolved in [ADR-0003](0003-non-shell-environment.md), and R03 in
[ADR-0004](0004-owned-key-exit-guard.md). Exact security and paid search
accounting contracts and their validation remain pending.

## Reassessment Conditions

Reopen this decision if the vendor changes authentication or applicable terms,
the usage/retention requirements cannot be satisfied, the credential route
cannot pass its gates, or the user changes the authentication scope. Disable
an incompatible backend rather than silently switching vendors or weakening
the confirmed rules.

## Execution Status

Documentation only. No feature code, installation, Git operation, credential
entry, account agreement, or paid API request was performed.
