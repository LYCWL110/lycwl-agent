# ADR-0089: Report a provider's model-not-found body as such

- Status: Accepted (2026-11-18)
- Related: ADR-0069 (model details), ADR-0071 (reasoning declarations), ADR-0087 (model context discovery and default)

## Decision

A model lookup may be answered with HTTP 200 and an error envelope instead of a
model record. Observed from a gateway as:

```json
{"error":{"message":"The model 'x' does not exist","type":"invalid_request_error","param":"model","code":"model_not_found"}}
```

`parseModelDetails` now recognizes that body before attempting to read a record,
so the failure is `model_not_found` rather than `unexpected_shape`. The latter
described the reader's expectation, not the provider's answer, and the two lead
to different actions: one means the model name is wrong, the other means the
endpoint did not return what the protocol promises.

Only codes on a fixed allowlist are repeated, currently `model_not_found`. An
unrecognized `error.code` still yields `unexpected_shape`, so a provider cannot
put arbitrary text into a value this layer reports. A record that merely carries
an unrelated `error` field is still read as a record.

The configuration browser names the case: "Model details unavailable: the
provider reports no such model". Every other detail failure keeps the existing
"Model details unavailable; support unknown", because it is a different problem.

## Consequences

Nothing changes about what is applied. Context still resolves through
ADR-0087's order — manual, upstream, then 272000 tokens — and reasoning still
offers `default` only when the upstream declares no levels. A failed lookup
remains non-blocking: the browser stays usable and a hand-typed model name can
still be saved.

The list endpoint is unchanged. An error envelope there is still
`unexpected_shape`, because that path is not observed to answer this way and
widening the allowlist without evidence would guess at other gateways.
