# ADR-0053: OpenAI Responses Adapter

- Status: Implemented, contract-tested and socket-tested; no real vendor request made
- Date: 2026-11-05
- Related: ADR-0051 (Chat Completions), ADR-0052

## Context

V1_BASELINE names four initial protocol families. Two were implemented; Responses was
the third. It is not a variant of Chat Completions: the request and response shapes
differ enough that reusing the chat adapter would have produced a request the endpoint
rejects.

## Decision

Add a Responses adapter with its own request builder and response interpreter, sharing
transport and status classification.

### Structural differences

| Concern | Chat Completions | Responses |
| --- | --- | --- |
| Request body | `messages` array | typed `input` array |
| Trusted rules | `role: "system"` message | top-level `instructions` |
| Tool call | nested in assistant `tool_calls` | its own `function_call` item |
| Tool result | `role: "tool"` message | `function_call_output` item |
| Tool definition | `function.parameters` | flat `name`/`parameters` |
| Completion signal | `finish_reason` | `status` |

### Refusals that matter

- **`status: "incomplete"` and `"failed"` are rejected** as `invalid_response`, so a
  truncated turn cannot yield executable calls even when the calls parse.
- **A `refusal` block is rejected** rather than presented as assistant text. A
  refusal is a real answer, but the neutral conversation has no place for it, and
  silently mapping it to text would misreport what happened.
- **`reasoning` items are dropped**: provider narration, not a recordable result.
- **An unknown item type is rejected**, not skipped, because a new item type could
  carry something the Runtime must not ignore.
- **Malformed argument JSON is rejected**; an empty string means no arguments.

## Verification

- 1172 tests pass across 255 suites; the vitest suite runs 12 render tests.
- 25 contract tests cover request construction, credential placement, instructions
  placement, user/assistant/function-call/function-output mapping, failure marking,
  flat tool definitions, every interpretation path including incomplete, failed,
  refusal and unknown item, and every HTTP status class.
- A socket test drives the real adapter, transport and coordinator against a local
  self-signed server: the follow-up input is
  `message → function_call → function_call_output` with a string `arguments` and a
  matching `call_id`, and a missing credential fails before the socket.
- `pnpm run verify` exits 0.

## What This Still Is Not

- **One of four protocols remains**: Google GenerateContent.
- **No real vendor request**, so compatibility, price and quality are unverified;
  G01 and G07 remain open.
- **No streaming**, so `status` transitions during a stream are not exercised.
- **No socket-level retry test**, same as the other adapters.

## Consequences

- Three of four selected protocol families now exist, each with contract tests and
  two of them with a real socket round trip.
- The shared `provider-response.ts` now serves three adapters, which is stronger
  evidence that it generalizes rather than fitting one vendor's quirks.

## Reassessment Conditions

Add the fourth protocol with its own contract suite. Do not infer capability from a
protocol name; G01 evidence is separate.
