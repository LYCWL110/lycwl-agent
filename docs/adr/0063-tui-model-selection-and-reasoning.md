# ADR-0063: TUI Model Selection And Reasoning Effort

- Date: 2026-11-06
- Status: Authorized by the user's request; implemented with local regression coverage
- Related: ADR-0060, ADR-0061, ADR-0062; V1_CONTRACTS C03; V1_DESIGN_SUPPLEMENTS S02

## Problem

The transcript repeated each final assistant reply in a `sys` run-completed row.
Model-list loading also required a saved connection, while saving a first
connection required an existing model ID. A newly entered key could never fetch
models in that flow. Failures were turned into empty lists, hiding the reason
the browser had nothing to select. Reasoning effort had no configuration path.

## Decision

Keep completion events and run status, and omit the redundant completion row
from the conversational transcript. Waiting, cancellation and failure remain
visible.

Entering the Model field opens the catalog and fetches models. An explicitly
entered draft key can authenticate to its validated draft HTTPS destination.
A stored key may only be reused when the destination and credential reference
match the saved connection. Browsing does not persist either the draft or key.
List failures remain failures and allow manual model IDs. Request generations
discard stale replies after protocol changes, leaving the catalog, saving or
closing configuration.

Persist an optional reasoningEffort for OpenAI Chat and Responses. Default
omits the parameter. The explicit levels are none, minimal, low, medium, high
and xhigh; these choices do not assert model or gateway compatibility.
Chat serializes reasoning_effort and max_completion_tokens when an effort is
specified; Responses serializes reasoning.effort. Anthropic thinking mapping
is not implemented, and the UI resets effort to default when selecting that
protocol. Nondefault Anthropic effort is rejected at validation.

Both OpenAI request paths also use the shared protocolEndpoint builder so
a configured base ending in /v1 does not produce /v1/v1 on the actual model
request. Configuration-to-adapter tests verify the URL as well as the body.

Saving still applies to the next Run. No in-flight route or automatic resume
policy changes. No dependency or credential-storage change is introduced.

## Validation And Limits

Regression coverage includes duplicate replies, first-time model discovery,
stored-key destination protection, stale fetch replies, failed-list display,
selection and effort persistence/reopening/reset, config-to-adapter request
wiring, keyboard interaction and narrow terminal layout. Architecture checks
and existing local TLS protocol round trips cover the affected boundaries.

No real Provider or paid request is used for these tests. A server without a
model-list API still needs a manual model ID. Live model/endpoint acceptance
of effort levels and full G08 validation remain outstanding.
