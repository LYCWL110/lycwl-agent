# ADR-0060: Configuration Entirely Inside The TUI

- Status: Implemented and verified locally; no web interface exists
- Date: 2026-11-05
- Related: ADR-0059 (browser and palette), ADR-0039 (setup)

## Context

ADR-0059 delivered a tested browser reducer and a palette but recorded that nothing
mounted them: `/config` set a flag no entry-point code consumed. Configuration was
still a first-run-only flow, so a configured user could not switch protocol or model.

The user's instruction was explicit: configure inside the TUI, following the Miyu
approach, with no web page.

## Decision

Make the TUI the only configuration surface.

### Flow (`bootstrap/config-flow.ts`)

Two phases, mounted one at a time because both use Ink's `useInput`:

1. **setup** — endpoint, model, credential reference, API key;
2. **browser** — protocol and model, with a fetched list when available.

A successful save moves to the browser rather than starting the Session, so the
protocol can be chosen before the first Run. That is the step the first-run screen
could not do.

### Reopening configuration

`/config` in the composer sets a request the controller exposes as
`takeConfigRequest`. `startTui` consumes it, unmounts the app and starts the flow
again. It is refused while a Run is in flight, because a configuration change selects
the **next** Run and swapping the route mid-Run would break the C03 binding.

Discarding configuration returns to a fresh Session with the previous settings intact.

### Model list (`adapters/providers/model-list.ts`)

`provider-http` gained a bounded `GET` sharing every guarantee with the `POST` path:
HTTPS only, no proxy inheritance, no redirect following, bounded connect/total time
and response size. A GET sends no `content-length`.

The list parser accepts the shapes providers actually return — `{data: [...]}`,
`{models: [...]}`, a bare array of objects, or a bare array of strings — and rejects
anything else rather than reporting an empty catalogue. Results are sorted and
deduplicated because a provider's ordering is not a promise.

A **404 is `not_supported`, not an error**: an endpoint that does not offer a list is
normal. A fetch failure leaves the browser usable with a hand-typed name, because a
configuration screen must not become unreachable when the network is down.

## Verification

- 1251 tests pass across 274 suites; the vitest suite runs 12 render tests.
- 16 model-list tests cover every accepted shape, sorting/dedup, missing ids, the
  `name` fallback, non-JSON and unexpected shapes, the Anthropic versus OpenAI header
  split, 404, 401, a missing key making no call, and a transport failure.
- `pnpm run verify` exits 0.
- `--setup` on this machine reports the existing provider, so the configured path is
  reachable.

## What This Still Does Not Do

- **No model fetch is wired in production.** `startConfigFlow` accepts a
  `fetchModels` option and nothing passes one, so the browser shows only the model
  from setup. Wiring it means a real vendor request, which is a separate
  authorization.
- **No endpoint or key editing inside the browser.** Changing them still requires the
  setup phase, which the flow re-enters only from `/config` on a fresh start.
- **The browser's provider column is inert**, because v1 configures one provider per
  Session.
- **No gradient banner**; the palette supports one and nothing draws it.
- No streaming, and one of four protocols remains.

## Consequences

- Configuration is one surface, inside the terminal, with no web dependency.
- Protocol and model can be changed without editing files by hand.
- The remaining gap is the production fetch wiring, stated rather than implied.

## Reassessment Conditions

Wire `fetchModels` only with an authorized real request and a reviewed endpoint. Add
in-browser endpoint editing when the setup phase proves too coarse.
