# ADR-0059: Three-Column Provider Browser And Adaptive Palette

- Status: Implemented and verified locally; model fetching not implemented
- Date: 2026-11-05
- Related: ADR-0039 (setup), ADR-0051/0053 (protocols)

## Context

Two problems, reported together: the TUI could not switch protocol after setup, and
it looked poor. Both were real. Configuration was a first-run-only flow, and the
renderer used Ink defaults with no palette, no focus indication and no status
distinction.

The Miyu reference (`src/config_tui/providers.rs`,
`crates/miyu-base/src/terminal/palette.rs`) was read for structure, not copied: it is
Rust with ratatui, and most of its surface — personas, emotion, QQ integration — has
no counterpart here.

## Decision

### Browser (`tui/config-browser.ts`)

A pure reducer over key events, so every rule is testable without a terminal. Three
columns — provider, protocol, model — with independent cursors and scroll offsets.

What was borrowed from the reference, and why:

| Reference behaviour | Adopted as |
| --- | --- |
| three columns, one focus | `activeColumn`, `tab`/`left`/`right` |
| independent scrolling | per-column `scroll` offsets, cursor kept visible |
| filter mode captures typing | typing only reaches the filter when it is open |
| status line distinguishes info from error | `status.isError` drives the colour |
| deleting a provider is undoable | a one-step snapshot before a model delete |
| fetched models are shown, not owned | `source: "custom" \| "fetched"`; only custom can be deleted |
| custom models pinned ahead of fetched | merge keeps custom entries first and dedupes |

Deliberate differences: v1 has one provider identity per Session, so the provider
column cannot move; and the undo slot holds exactly one step, because a deeper stack
would need a reason to exist first.

`/config` opens the browser. It is refused while a Run is in flight: a configuration
change selects the **next** Run, and swapping the route mid-Run would break the C03
binding.

### Palette (`tui/palette.ts`)

The reference's core idea is kept: a design palette declared once, degraded by
capability, where a downgrade is a different means of expressing the same
distinction rather than fewer colours.

- `NO_COLOR` wins over everything, matching the cross-tool convention;
- four depths: truecolor, 256, 16, mono;
- at 16 colours or below, **focus is shown by reverse video** rather than colour;
- gradients are not drawn below 256 colours, because a gradient that jumps between
  blocks reads worse than one colour.

The module is pure: it reads no environment, so every depth is testable.

## Verification

- 1235 tests pass across 272 suites; the vitest suite runs 12 render tests.
- 26 unit tests cover navigation and clamping, commit and cancel, filter capture and
  escape semantics, delete/undo including a fetched model being refused, custom-model
  add/merge with dedup and ordering, and every palette depth including `NO_COLOR`
  precedence, forced depth, empty `TERM`, and reverse-video focus at low colour.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No model fetching.** The reference pulls a provider's model list. That needs a
  GET transport (the current one is POST-only) and a real vendor request, which is a
  separate authorization. `mergeFetchedModels` exists and is tested, but nothing calls
  it with network data.
- **The browser is not wired into the running TUI yet.** `/config` sets a flag the
  controller exposes as `takeConfigRequest`, but no entry-point code consumes it and
  mounts `ConfigBrowser`. The reducer and the view exist and are tested; the mount is
  the remaining step.
- **No gradient banner.** `gradientWorthDrawing` exists; nothing draws one.
- **Provider column is inert** because v1 configures one provider per Session.
- No streaming, and one of four protocols remains.

## Consequences

- Protocol and model switching is now a modelled, tested interaction rather than an
  absent feature.
- The renderer has a palette and a focus rule that survive a low-colour terminal.
- The gap between "reducer tested" and "user can press /config" is stated, not
  implied.

## Reassessment Conditions

Wire the browser into the entry point before claiming the feature is usable. Add
model fetching only with an authorized GET path and a reviewed vendor endpoint.
