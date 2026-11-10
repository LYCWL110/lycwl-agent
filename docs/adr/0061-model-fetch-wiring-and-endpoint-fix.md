# ADR-0061: Wiring Model Fetching And Fixing The Endpoint Version Segment

- Status: Implemented; verified against the user's endpoint (which does not support it)
- Date: 2026-11-05
- Related: ADR-0060 (TUI-only configuration)

## Context

ADR-0060 recorded that `startConfigFlow` accepted a `fetchModels` option and nothing
passed one, so the browser only showed the model typed during setup.

Wiring it exposed a defect that would have broken the user's existing configuration.

## Defect: duplicated version segment

The user's saved base URL is `https://<provider-host>/v1`, which is what a
provider console typically displays. `protocolEndpoint` appended its own version:

```
https://<provider-host>/v1/v1/messages
```

That is a 404 for every request. The configuration was saved correctly and would have
failed at the first send with an opaque error.

`protocolEndpoint` now strips a trailing `/v1` or `/v1beta` before appending, so a
pasted version root is respected rather than duplicated, while a non-version path
prefix such as `/openai` is preserved.

This is the kind of defect a unit test of the builder would not catch, because the
builder was internally consistent — it was the assumption about input that was wrong.
It surfaced only by running the real saved configuration through it.

## Decision

Pass a real `fetchModels` from the entry point.

- `fetchModelsForBrowser` calls `fetchModelList` and, on failure, writes the reason to
  stderr and returns an empty list, so the browser stays usable with a hand-typed
  name.
- The fetch uses the protocol read from the saved document rather than a hard-coded
  one, because the user may have configured an OpenAI protocol.

## Verified Against The User's Endpoint

Running the real credential and base URL returned `not_supported`: that endpoint does
not expose `/v1/models`. That is the designed outcome — a 404 is reported as
"not supported", not as an error, and the browser falls back to a typed name. It also
confirms the fetch path reaches the network and classifies the response correctly.

## Verification

- 1256 tests pass across 275 suites; the vitest suite runs 12 render tests.
- Five new endpoint tests cover: an existing `/v1`, `/v1beta`, no version at all, a
  trailing slash in both forms, and a non-version path prefix.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No endpoint or key editing inside the browser.** Changing them still requires the
  setup phase.
- **A provider without a model list is the normal case here**, so the browser will
  usually show only the typed model. That is honest rather than a failure.
- The provider column remains inert; v1 configures one provider per Session.
- No gradient banner, no streaming, and one of four protocols remains.

## Consequences

- Configuration-time fetching works and degrades gracefully.
- The version-segment defect is fixed and pinned by tests, so a pasted `/v1` no longer
  breaks every request.
- The user's endpoint behaviour is now known rather than assumed.

## Reassessment Conditions

Add in-browser endpoint editing when the setup phase proves too coarse. Revisit the
version rule only with a provider that uses a different version root.
