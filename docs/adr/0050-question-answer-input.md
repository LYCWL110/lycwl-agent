# ADR-0050: Question Answers Accept An Id Or The Visible Label

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0049

## Context

ADR-0049 recorded a usability gap: a choice answer passed the composer text straight
through as an option id. The panel renders `id) label`, so a user naturally types the
label — which produced `invalid_option` with no explanation. Typing `a` worked only
because the id happened to match.

An interface that shows you a label and then rejects it is broken even though the
coordinator behaved correctly.

## Decision

Resolve composer text in a small pure module (`tui/answer-input.ts`) before it
reaches the coordinator.

### Choice

- an exact **id** wins outright, so an id that also appears inside a label is never
  shadowed;
- otherwise an exact **label** match is accepted;
- an **ambiguous** label (two options sharing one) is **rejected**, not guessed:
  picking one would record an answer the user did not give;
- multiple selection accepts a comma-separated list mixing ids and labels;
- a repeated selection is rejected rather than silently deduplicated, because
  recording it as one choice would misreport what was typed;
- when the question allows free text and the entry matches no option, the text is
  passed through as a free-text answer.

### Confirmation

`yes/y/true/1` and `no/n/false/0` are accepted case-insensitively; anything else is
rejected with the expected input named.

### Errors are visible

A rejected answer keeps the question open and sets `answerError`, which the panel
renders as `not accepted: <reason>`. The panel also states the expected input form,
which varies by answer type and multiplicity.

## Verification

- 1119 tests pass across 247 suites; the vitest suite runs 12 render tests.
- 16 unit tests cover: id, label, trimming, id-over-label precedence, unknown
  option, empty input, ambiguous labels, ambiguous-then-id, multiple with labels,
  mixed ids and labels, repeated selection, confirmation variants, free text, and
  free text via an unmatched choice.
- Two integration tests drive the real controller: typing `src/b.ts` completes the
  Run with that label recorded, and typing a nonexistent value keeps the question
  open with a visible error before a valid answer completes it.
- `pnpm run verify` exits 0.

## What This Still Is Not

- **No interactive selection.** There is no arrow-key menu; the user types. That is
  a UX decision not yet made.
- **Comma splitting is naive.** A label containing a comma in a multiple-choice
  question cannot be selected by label, only by id.
- **The demo runtime still never asks a real question**, so this is proven at the
  controller level with a scripted provider.
- No streaming, and three of four protocols remain unimplemented.

## Consequences

- Typing what the panel shows now works, which is the minimum bar for an interface.
- Ambiguity and repetition are surfaced instead of resolved by guessing, so a
  recorded answer is always one the user actually gave.
- The resolution rules live in one tested place rather than inline in the controller.

## Reassessment Conditions

Add a selectable list when the question panel gets real UX work. Revisit comma
splitting if a label with a comma becomes realistic.
