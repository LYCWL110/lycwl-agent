# ADR-0051: OpenAI Chat Completions Adapter

- Status: Implemented and contract-tested; no real vendor request made
- Date: 2026-11-05
- Related: ADR-0037 (Anthropic adapter), ADR-0039 (configuration)

## Context

V1_BASELINE section 6 names four initial protocol families. Only Anthropic Messages
was implemented, so a user with an OpenAI-compatible key could not configure the
product at all.

## Decision

Add a Chat Completions adapter and make the protocol a real configuration choice.

### Structural differences the adapter owns

| Concern | Messages | Chat Completions |
| --- | --- | --- |
| System prompt | top-level `system` field | `role: "system"` message |
| Tool call arguments | JSON **object** | JSON **string** |
| Tool results | `tool_result` block in a user turn | separate `role: "tool"` message |
| Tool definition | `input_schema` | nested `function.parameters` |

The transport and HTTP status classification are shared with the Anthropic adapter,
so the Runtime's retry policy sees identical categories from both. That sharing is
the point of `provider-response.ts`: four adapters must not drift into four opinions
about what a 429 means.

### Two behaviours that needed care

**A truncated turn must not yield tool calls.** `finish_reason: "length"` and
`content_filter` are rejected as `invalid_response`, because executing a call parsed
from a truncated response is precisely what the baseline forbids. A test asserts the
calls are discarded even when they parse cleanly.

**Malformed argument JSON is rejected, not coerced.** Substituting `{}` for
unparseable arguments would silently change the call's meaning. This is distinct
from an *empty* argument string, which some providers send for a tool that takes
none; that is accepted as `{}`.

### Protocol selection

`SUPPORTED_PROTOCOLS` now contains both, `protocolEndpoint` derives the path from the
protocol, and `assembleRuntime` constructs the matching adapter. An unserved protocol
still fails as `unsupported_protocol`, so the refusal remains meaningful rather than
becoming "anything goes".

## Defect Found While Testing

The first implementation rejected an empty `arguments` string as malformed. The
contract test for "empty arguments" failed. The fix distinguishes three cases that
were conflated: empty string → `{}`, absent/null → `{}`, and any other non-string →
invalid.

## Verification

- 1143 tests pass across 250 suites; the vitest suite runs 12 render tests.
- 23 contract tests cover request construction, credential placement, system
  message, argument serialization (object input, string on the wire, empty case),
  tool-result mapping including failure marking, tool-definition wrapping, response
  interpretation, truncation and content-filter rejection, malformed arguments, and
  every HTTP status class.
- An existing test asserting `openai_chat` was unsupported now asserts a genuinely
  unserved protocol, plus a new test that `openai_chat` is accepted.
- `pnpm run verify` exits 0.

## What This Still Is Not

- **Two of four protocols remain.** OpenAI Responses and Google GenerateContent are
  unimplemented, and each needs its own contract tests.
- **No end-to-end run against a local server for this adapter.** The Anthropic
  adapter has a real-TLS round-trip test; this one is contract-only. The transport is
  shared and already proven, but the chat-specific request/response path has not been
  driven through a socket.
- **No real vendor request**, so compatibility, price and quality are unverified.
  G01 and G07 remain open.
- No streaming.

## Consequences

- A user can configure either of two protocol families and the runtime picks the
  right adapter from configuration.
- The shared classification layer now serves two adapters, which is the first
  evidence that it generalizes rather than fitting one vendor.

## Reassessment Conditions

Add an end-to-end socket test for this adapter before claiming it works, and add the
remaining two protocols with their own contract suites. Do not infer capability from
a protocol name; G01 evidence is separate.
