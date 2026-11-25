# ADR-0024: Experimental Provider-Native Web Search Mode

- Status: Historical experiment. `main` later adopted native search under ADR-0096 with a different policy.
- Date: 2026-11-04
- Supersedes: nothing. It conflicts with, and does not weaken, ADR-0002 and ADR-0023.
- Superseded in part by: ADR-0096 (native search default for Anthropic and Responses).
- Related: ADR-0002, ADR-0023, V1_CONTRACTS.md C07, V1_BEHAVIOR_CONTRACTS.md sections 2.5/2.6

## Context

ADR-0002 selected a Harness-executed search backend and explicitly rejected
delegating search to the model provider. It recorded that the local Claude Code
snapshot's `WebSearchTool` uses a model-hosted server tool
(`web_search_20250305`) and that this project does not adopt that coupling. The
reason was concrete: if the Provider searches inside its own request, the
Harness cannot approve the exact query, reserve quota before dispatch, record a
charge, bound the result count, pin addresses or separate retrieved content from
model narration.

The user asked for a branch that explores the model-native mode anyway, to
compare it against the Harness-executed tool. That request is a request to
explore, not a decision to replace the confirmed contract.

## Decision

Implement provider-native search on `feat/model-websearch` as an **explicit,
opt-in, gated** mode, with the lost guarantees computed as data rather than
described in prose.

Three policies exist, selected per Run and fixed at Run start:

| Policy | `web_search` tool | Search execution | Guarantees |
| --- | --- | --- | --- |
| `disabled` | not registered | none | none needed |
| `harness_tool` | registered | Harness performs the call | full confirmed contract |
| `provider_native` | **not registered** | Provider, inside its own request | six confirmed guarantees waived |

`provider_native` is refused, not silently downgraded, when either condition
fails:

- the Provider does not declare `capabilities.serverSideSearch`, or
- the user did not pass an explicit per-Run opt-in.

A refusal places the Run in `waiting` for `configuration` and sends nothing. It
does not fail the model request and does not look like an unknown charge,
because nothing left the machine.

## What `provider_native` Gives Up

`MODEL_SEARCH_DEGRADATIONS` in `src/domain/web/model-search.ts` is the normative
list, recorded in the `search_policy_selected` event and shown by the TUI:

| Code | Confirmed rule lost |
| --- | --- |
| `no_per_call_query_approval` | AGENTS.md: one-shot approval of the exact query per invocation |
| `no_quota_reservation_or_ledger` | C07: 10 per Run, 100 per UTC month, reserved before dispatch |
| `no_charge_record` | C07/ADR-0017: an unknown charge must be recorded, never assumed free |
| `no_result_count_or_locale_control` | ADR-0021: count, fixed vendor depth, language/location codes |
| `no_address_binding_or_redirect_control` | WebFetch policy: resolved address set shown and pinned |
| `no_result_provenance` | Results arrive inside model text; retrieval cannot be separated from narration |

These are not advisory notes. They are why this mode cannot be presented as an
equivalent of `harness_tool`, and why the branch is not merged.

## Enforced Properties

- The policy is resolved once in `RuntimeCoordinator.run` and stored on the Run
  context; a later configuration change cannot change it mid-Run.
- `provider_native` never registers `web_search`. The session tool view returns
  `null` from `getDefinition` and a `web_search_delegated_to_provider` failure if
  a model still emits the call, so the model cannot reach an unapprovable path.
- `web_fetch` stays Harness-executed under both enabled policies.
- `serverSideSearch` is passed on every attempt of the logical request, so a
  retry does not silently switch between modes.
- `search_policy_selected` is an authoritative event, so the TUI and any
  post-hoc report read the waiver list from facts rather than from assumptions.

## Evidence Limits

- No request was made to a real vendor. The end-to-end test points the adapter
  at a local self-signed HTTPS server, so the transport, the request body and the
  response interpretation are real, but the vendor is not.
- Which providers actually support server-side search, what they charge, and
  whether results are attributable were **not** verified. `capabilities` is a
  declaration by the adapter, not a checked vendor fact.
- Because search happens inside the model request, this mode does not and cannot
  use the C07 ledger. There is no partial version: either the ledger governs
  search, or the Provider does.
- This ADR does not change ADR-0002 or ADR-0023 for `main`. It records an
  experiment that exists to be compared, and rejected by default.

## Implemented Surface

- `src/domain/web/model-search.ts` — policy selection, refusal codes, the
  normative degradation list.
- `src/adapters/providers/anthropic-provider.ts` — a concrete provider-native
  adapter that requests the `web_search_20250305` server tool, injects the key
  from a resolver (never the environment, never model context), rejects redirects
  and unknown content blocks, and deliberately discards `server_tool_use` /
  `web_search_tool_result` blocks so provider narration never becomes a
  Harness-recorded tool call.
- `src/adapters/providers/http-post.ts` — bounded HTTPS POST for trusted adapter
  authentication: no proxy inheritance, no redirect following, bounded connect
  and total time, bounded body size.
- Coordinator: policy fixed per Run, `provider_native` hides `web_search`,
  `serverSideSearch` sent on every attempt.

The adapter proves the mode is expressible and gateable. It is not evidence that
the vendor's search is good, cheap or honest.

## Consequences

- The comparison the user asked for now exists in code and tests, on one branch,
  isolated from the metered path.
- Accuracy risk is explicit: with no result provenance, the Harness cannot tell a
  retrieved page from a fabricated citation. Any product use would need a
  separate decision accepting that.
- Keeping the branch unmerged means `main` keeps the full confirmed contract.

## Reassessment Conditions

Revisit only if a Provider offers a server-side search surface with per-query
control and attributable results, or if the user explicitly accepts losing all
six guarantees for a specific Provider. Absent that, `main` keeps
`harness_tool`.
