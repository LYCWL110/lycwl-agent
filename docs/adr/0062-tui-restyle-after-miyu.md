# ADR-0062: Restyling The Main TUI After The Miyu Layout

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0059 (palette), ADR-0060 (configuration)

## Context

The user reported, correctly, that the main TUI had not changed. ADR-0059 added a
palette and a browser, but `app.ts` still used bracketed role labels, a `run:…` header
and no colour at all. The palette existed and the main screen ignored it.

## Decision

Rewrite `app.ts` around the reference's structure, adapted to what this Harness has.

What was taken from `src/cli/footer.rs` and the surrounding layout:

| Reference element | Adopted as |
| --- | --- |
| message gutter / prefixes | a `▌` gutter plus a role label per entry |
| coloured bar on the input's left edge | `▌ task › …_` in the lane accent |
| one-line footer: mode left, detail right | `ready`/`running`/`waiting:…` left, model and code right |
| one accent colour across input, mode and panels | `colorFor("primary"/"secondary"/"tertiary")` |
| panel markers for approval and question | `▌ approval required · shell`, `▌ question · …` |
| per-item todo state markers | `[ ]`, `[>]`, `[x]`, `[-]` with role colours |

What was deliberately not adopted: persona lanes, thinking variants, a token meter,
waveform animation and goal hints. This Harness has none of those concepts, and drawing
them would be decoration that implies capability.

### Colour is optional everywhere

`capabilities` is an optional prop, so a test can render every depth without touching
the process environment. `colorProps` builds the Ink prop only when a colour exists,
because Ink rejects an explicit `undefined`.

## Defects Found While Testing

- My first appended tests used `"\\n"` and `"\\.` inside template strings, which
  produced literal backslashes and made the assertions match the wrong thing. That is
  a test bug, not a product bug, but it is worth naming because the failure looked
  like a rendering fault.
- `lastFrame()` in this testing library returns the most recent **write**, which for a
  tall layout is one row. A multi-line assertion must read `frames` instead. The test
  that counted lines was therefore wrong, and the one asserting on the footer was
  wrong for the same reason.

## Verification

- 1256 tests pass across 275 suites; the vitest suite runs 15 render tests.
- Render tests assert: the idle prompt, role labels and a failed tool status, todo
  markers, the approval panel with its exact command prompt, the question panel with
  options and hint, queue mode, the failure code in the footer, mono-mode rendering,
  the gutter bar, and the model label in the footer.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No gradient banner.** The palette supports one and nothing draws it; the
  reference's art is a large feature with a starfield and a sweep, not a small addition.
- **No token meter, timer or waveform**, because there is no per-turn accounting to
  display.
- **No width-aware truncation.** The reference drops the least important footer
  segment when the line does not fit; this layout has few enough segments that it does
  not, but a narrow terminal may wrap.
- **No keyboard navigation of the transcript** (scrolling, paging), which the
  reference has.
- No streaming, and one of four protocols remains.

## Consequences

- The main screen now uses the palette, so the earlier work is visible rather than
  dormant.
- The accent colour is consistent across input, panels and footer, which is what makes
  the screen read as one interface rather than a set of stacked boxes.
- The gap between "styled" and "feature-complete like the reference" is stated.

## Reassessment Conditions

Add width-aware segment dropping before claiming the footer is robust on narrow
terminals. Add a banner only as a deliberate visual feature, not as part of layout
cleanup.
