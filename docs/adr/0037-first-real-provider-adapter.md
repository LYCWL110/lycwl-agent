# ADR-0037: First Real Provider Adapter On Main (Anthropic Messages)

- Status: Adapter implemented and contract-tested; no real vendor call made
- Date: 2026-11-05
- Related: V1_BASELINE.md section 6; C03; ADR-0028; ADR-0034

## Context

`main` had no model Provider at all: the only implementation was the scripted
`DemoProvider`. The `feat/model-websearch` branch contains a different adapter, but
that branch is the provider-native search experiment and is not to be merged.

So this is new work on `main`, not a merge.

## Decision

Add a real Anthropic Messages adapter plus a bounded HTTPS transport, and keep the
four-protocol target honest by implementing one protocol properly.

### Transport (`adapters/providers/provider-http.ts`)

A bounded HTTPS POST for **trusted adapter authentication**. This is explicitly not
the WebFetch policy path, and the difference is stated in the code:

- the Provider endpoint comes from user configuration, so address pinning and
  per-connection address approval do not apply;
- WebFetch targets come from model output, so they do.

Shared and still enforced: no proxy inheritance, no redirect following (a 3xx is
reported, never followed — following one could move credentials to another host),
bounded connect/total time, bounded request and response size, HTTPS only. A
plaintext Provider endpoint is refused outright rather than warned about, because
there is no user-confirmation flow on this path that could make it acceptable.

### Adapter (`adapters/providers/anthropic-provider.ts`)

Builds the request from neutral conversation items, POSTs, normalizes the reply.
It does not dispatch tools, decide permissions, retry, or retain a credential.

- the key is resolved per call through an injected resolver, so rotation applies to
  the next attempt and no secret is stored on the adapter;
- the key travels as `x-api-key` and never appears in the body, an event or a log;
- the assistant turn is rendered with its `tool_use` blocks, and each
  `tool_result` references that id, which is what makes the follow-up history legal;
- `thinking`, `redacted_thinking` and server-tool blocks are dropped rather than
  treated as content: they are vendor narration, not Harness-recorded results;
- an unknown block type is rejected, not skipped, because a new block type could
  carry something the Runtime must not silently ignore.

### Shared response classification (`adapters/providers/provider-response.ts`)

401/403 → authentication failure; 429 → transient with `Retry-After` clamped to 60s;
5xx → transient; 3xx → invalid; other 4xx → invalid; transport timeout/connect/TLS
→ transient; oversized or invalid endpoint → invalid.

One place decides this so four protocols cannot drift into four opinions about what
a 429 means. `safeCode` names a category rather than echoing vendor text, because
provider error strings are untrusted input.

## Defect Found While Testing

The first end-to-end run failed with `provider_tls_failed`. Cause: the transport set
`servername` unconditionally, including for an IP literal. RFC 6066 does not permit
an IP as SNI, Node ignores it and emits a deprecation warning, and the handshake
then failed against a certificate that did not cover the IP.

Fixed by omitting `servername` for IP literals. This matters beyond the test: a user
may configure an endpoint by IP, and that would have failed with an opaque TLS error.

## Verification

- 35 contract tests: request shape, credential placement, assistant/tool-result
  mapping, tool-definition passthrough, response interpretation, every HTTP status
  class, every transport failure, endpoint rejection.
- 1 end-to-end test against a local self-signed HTTPS server driving the **real**
  adapter, the **real** transport and the **real** coordinator: two HTTPS requests
  complete a tool round trip, the credential is a header, and the follow-up history
  carries `user → assistant(tool_use) → user(tool_result)`.

No request was made to a real vendor. No API key exists for this project yet.

## What This Is Not

- **Not a working agent.** `lycwl` still runs the demo runtime. There is no TUI
  configuration screen, so a user cannot set a provider, endpoint, model or key, and
  nothing constructs an `AnthropicProvider` outside tests.
- **One of four protocols.** OpenAI Chat Completions, OpenAI Responses and Google
  GenerateContent are untested and unimplemented. V1_BASELINE requires contract
  tests per selected adapter, not a minimum count.
- **No catalog or capability snapshot.** C03 binding exists as policy; nothing feeds
  it a frozen matrix, and capability claims are not verified.
- **Streaming is absent**, so the section 7 stream clocks have nothing to watch.
- G01 (provider matrix) and G07 (protocol tests) remain open. Compatibility, price
  and result quality are all unverified.

## Consequences

- The hardest remaining piece — actually talking to a model over TLS with a correct
  history — now exists on `main` and is proven against a real socket.
- Wiring it to the entry point is now a configuration-surface problem, not a
  protocol problem.

## Reassessment Conditions

Add the remaining three protocols with their own contract tests. Do not claim any
provider works until G01 evidence exists, and do not wire a real key until G03 is
validated.
