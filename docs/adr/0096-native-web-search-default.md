# ADR-0096: Provider-Native Web Search By Default, Tavily For Chat

- Status: Accepted (2026-11-25)
- Related: ADR-0021 (web boundaries), ADR-0023 (Tavily), ADR-0024 (native experiment), ADR-0094 (web default)

## Decision

Web search follows the selected protocol when web access is enabled:

| Protocol | Search path |
| --- | --- |
| `anthropic_messages` | Anthropic server tool `web_search_20250305`, `max_uses: 5` |
| `openai_responses` | Built-in `{ type: "web_search" }` tool |
| `openai_chat` | Harness `web_search` function tool backed by Tavily |

Native search is the default for the two protocols that support it. `openai_chat`
has no standard built-in search in Chat Completions, so it keeps the Tavily tool
and the purpose-bound `search-main` key.

When native search is used, the Harness `web_search` function tool is not
advertised. Publishing both would give the model two search paths with different
approval, cost and provenance rules. `web_fetch` stays Harness-executed under
every protocol: preview, one-shot approval, resolved-address binding and no
automatic redirects.

Compaction requests never request native search. The auxiliary summariser must
not spend search quota or add a provider-side action.

## Lost Guarantees

Native search runs inside the model request. The Harness cannot approve the exact
query before it is sent, reserve a C07 ledger slot, record a charge, control the
vendor result count, or label provider-returned results as Harness tool results.
The model's final text is recorded; native server-tool blocks and citations are
not reconstructed into neutral history. Native search output is untrusted model
context, not evidence that a Harness tool ran.

`--read-only` disables both paths. The launch summary reports `native`, `harness`
or `disabled`, and states the native trade-off.

## Consequences

Anthropic and Responses users get search without storing a Tavily key. Chat users
still need `lycwl --search-key`. The Tavily key remains unused under native
protocols.

A provider that rejects the built-in tool fails the model request; there is no
automatic fallback because a second attempt could spend money and would change
the approved path. This is a deliberate fail-closed choice until a fallback policy
is reviewed.

Anthropic native search is bounded by `max_uses: 5`. Responses cost is bounded by
the provider's own search behavior and the request's token budget.

## Reassessment Conditions

Revisit when native search needs a per-call approval path, when the provider
rejects the built-in tool often enough to require an explicit fallback, or when
native result provenance must be replayed across Sessions.
