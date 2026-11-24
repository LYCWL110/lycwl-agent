# ADR-0091: Stream Model Text To The TUI

- Status: Accepted (2026-11-24)
- Related: ADR-0033 (no-progress detection), ADR-0051 (OpenAI Chat adapter), ADR-0053 (OpenAI Responses adapter), ADR-0052 (Chat e2e), ADR-0069 (reasoning discovery)

## Decision

`ModelProvider` gains an optional `stream(request, onDelta)` method. When it is
present and the caller supplies an `onDelta` callback, the coordinator prefers it
over `complete`. When it is absent, or the request is the auxiliary compaction
request, the non-streaming method is used.

The three implemented adapters stream over SSE:

- OpenAI Chat: `stream: true` plus `stream_options.include_usage`, accumulating
  `delta.content` and `delta.tool_calls` by index.
- OpenAI Responses: `response.output_text.delta` for display, and the
  `response.completed` payload is passed through the existing non-streaming
  interpreter so tool-call and usage handling stay in one place.
- Anthropic Messages: `message_start`, `content_block_start`,
  `content_block_delta`, `message_delta` and `message_stop`, accumulating text and
  `input_json_delta` fragments.

Only text is emitted as a delta. Tool calls are assembled inside the adapter and
delivered on the final completion, so the coordinator still executes a whole
response as one approved batch. No tool is dispatched from a partial response.

### Deltas are ephemeral

The coordinator keeps the accumulated text in `MutableRunContext.streamingText`.
`currentRunProjection()` exposes it to the TUI, and the TUI derives a synthetic
`assistant` transcript entry with status `streaming`. The entry is replaced by the
authoritative `model_response_validated` event when the response completes.

Deltas are never written to the event log, never replayed and never counted as
history. A session opened with `--resume` shows the final text only.

### Retry, failure and cancellation

`completeWithBoundedRetries` calls `onAttemptStarted` before each send. That
clears the streamed text, so a transient retry starts from an empty display rather
than appending a second answer to the first. If retries are exhausted, the partial
text is discarded and the Run reports its failure. Cancellation clears the text
as well. The bytes are never treated as a completed response.

### Transport

`providerHttpsPostStream` shares the bounded HTTPS rules with the existing POST:
HTTPS only, no proxy inheritance, no redirect following, bounded connect and total
time, bounded response bytes, and the same abort signal. A non-2xx response is
buffered and classified by `classifyHttpStatus`. A 2xx response that is not
`text/event-stream` is returned as `bodyText`, and the adapter falls back to its
non-streaming interpreter.

Malformed SSE frames are `invalid_stream`, a non-retryable invalid response. The
parser bounds both a single line and a single event.

OpenAI Chat requests include `stream_options.include_usage` so the final chunk can
carry token usage. A compatible server that rejects that field fails the request;
this change does not retry with a reduced body, because that would be a second
protocol attempt with different semantics.

## Consequences

The user sees text as it arrives instead of waiting for the whole response. The
authoritative history is unchanged: one `model_response_validated` event per
response, with the complete text and tool calls.

Streaming makes partial output visible, so a failed or retried attempt can show
text that later disappears. That is the necessary trade for live display; the
alternative is to buffer the whole answer, which is the previous behaviour.

The no-progress stream clocks in `domain/run/no-progress.ts` remain unwired. The
HTTP total timeout still bounds a request that never finishes, but a stream that
sends heartbeats without content is not separately detected yet. Wiring those
clocks is a follow-up, not part of this change.

Tool-call execution still waits for the complete response. This preserves the
approval ticket, the serial sibling policy and the "no call from a truncated
response" rule.
