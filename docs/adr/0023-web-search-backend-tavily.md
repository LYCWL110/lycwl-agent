# ADR-0023: Web Search Backend Change From DataForSEO To Tavily

- Status: Confirmed by explicit user instruction ("用opencode相同的方案"); design change only
- Date: 2026-11-04
- Supersedes: the backend selection in [ADR-0002](0002-search-authentication.md)
- Related: V1_BASELINE.md section 8; V1_CONTRACTS.md C07; ADR-0021; V1_BEHAVIOR_CONTRACTS.md sections 2.5/2.6

## Context

ADR-0002 selected DataForSEO Google Organic Live Advanced as the WebSearch
backend. That backend has no free tier: any real call requires a paid account,
an accepted agreement, and G10 terms review. The user asked whether search could
use a free allowance instead, reviewed how the reference projects do it, and
instructed: "用opencode相同的方案" ("use the same approach as OpenCode").

The reviewed evidence, already recorded in ADR-0002 and REFERENCE_EVIDENCE:

- Locked OpenCode separates the search service from its provider implementation
  at `packages/core/src/websearch.ts:35` and
  `packages/core/src/plugin/websearch/tavily.ts:48`.
- Local Claude snapshot `src/tools/WebSearchTool/WebSearchTool.ts` delegates
  search to a model-hosted server tool (`web_search_20250305`). ADR-0002
  explicitly rejected that coupling, and this ADR does not adopt it either.

## Decision

Replace the WebSearch backend with **Tavily**, matching the OpenCode approach,
so a free-tier allowance is usable.

What changes:

- The backend provider identity is Tavily; the adapter is configuration, not
  hard-coded behaviour.
- Authentication is a single Tavily API key held in Windows Credential Manager
  under a search-specific reference, keeping model authentication API-key-only
  and separate.

What does **not** change, and remains binding:

- Exact-query one-shot approval before every call; the preview shows the final
  query, count, depth and destination.
- C07 quota: 10 calls per Run and 100 per UTC calendar month, shared local-user
  ledger, reservation before dispatch, fail-closed on lock or corruption.
- No automatic retry, refund or recharge of a possibly-charged request.
- No scraping, no model-invented results, no silent provider fallback.
- Result count default 10, range 1-10, fixed vendor depth, and the surcharge
  refusal rule from ADR-0021 stay as confirmed.
- Prompt-injection and untrusted-content handling are unchanged.

## Evidence Limits

- Tavily's current free-tier size, rate limits, retention and redistribution
  terms were **not** verified in this change. They require G10 review before any
  real call, exactly as with DataForSEO.
- No Tavily request was made while writing this ADR.
- OpenCode's implementation is a reference for separation of concerns, not proof
  of Tavily's terms, availability, price or result quality.
- The prior DataForSEO documentation review remains historical evidence about a
  backend this project no longer selects; it must not be cited as current.

## Consequences

- A free tier makes limited real search possible without a paid vendor account.
- The exact-query approval contract is preserved because the Harness still
  performs the call itself rather than delegating it to the model provider.
- The C07 ledger is not optional: it must exist before any real Tavily call,
  because "free tier" is still a metered quota that can be exhausted.
- Switching back to DataForSEO or to any other vendor is a new ADR, not a
  configuration change.

## Reassessment Conditions

Revisit this decision if Tavily's free tier is withdrawn, if its terms forbid the
intended use, if tool-calling quality proves inadequate for search synthesis, or
if G10 finds the vendor incompatible.
