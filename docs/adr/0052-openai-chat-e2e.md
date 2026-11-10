# ADR-0052: End-To-End Socket Test For The Chat Completions Adapter

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0051

## Context

ADR-0051 added the Chat Completions adapter with contract tests only, and recorded
the gap explicitly: the Anthropic adapter had a real-TLS round trip, while the chat
adapter's request/response path had never crossed a socket. Shared transport code is
evidence about the transport, not about the adapter that uses it.

## Decision

Add `tests/integration/openai-chat-provider-e2e.test.ts`, driving the real adapter,
the real bounded HTTPS transport and the real coordinator against a local self-signed
server.

The first response asks for a tool; the second finishes. The test then asserts the
actual bytes that arrived:

- two HTTPS requests;
- `authorization: Bearer <key>` present and the key **absent from the body**;
- the model identifier;
- first request: a single `user` message with the task text;
- second request: `user → assistant → tool`;
- the assistant turn carries `tool_calls` with `arguments` as a **string** that
  parses to the expected object;
- the `tool` message carries `tool_call_id` matching the call and the executor's
  text.

A second case asserts that a provider with no resolvable credential fails before the
socket: the completion is `authentication_failure` and **zero** requests arrive.

## Verification

- 1145 tests pass across 251 suites; the vitest suite runs 12 render tests.
- Both new cases pass; the round trip completed with `status: completed` and the
  executor was invoked exactly once.
- `pnpm run verify` exits 0.

## What This Still Does Not Prove

- **Nothing about a real vendor.** The server is local and self-signed, and the
  responses are hand-written to the documented shape. Compatibility, pricing and
  result quality remain unverified; G01 and G07 stay open.
- **No streaming**, so stream framing is not exercised.
- **No retry behaviour over the socket.** A 429 or a dropped connection would go
  through `classifyHttpStatus`, which has contract coverage, but the combined
  socket-plus-retry path is not driven here.
- Two of four protocols remain unimplemented.

## Consequences

- Both implemented adapters now have a real-socket round trip, so the two are
  comparable in what has actually been executed rather than described.
- The chat-specific concerns — string arguments, `role: "tool"` messages, the system
  message — are now proven on the wire, not only in a builder function.

## Reassessment Conditions

Add a socket-level retry test together with a real transient-failure fixture. Do not
treat a local round trip as vendor compatibility evidence.
