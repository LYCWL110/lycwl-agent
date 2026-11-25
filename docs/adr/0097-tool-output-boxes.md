# ADR-0097: Bounded Tool-Output Boxes And Marked System Entries

- Status: Accepted (2026-11-25)
- Related: ADR-0095 (approval box), ADR-0074 (tool-output spill)

## Decision

A tool execution is shown as a bordered block instead of a bare line. The top
border carries the tool summary, expand marker and terminal status. By default
the block shows only the first two detail lines plus a count of hidden lines;
clicking any line or pressing Ctrl+T expands the full recorded output. Long
lines wrap inside the block and control characters are escaped by the same
renderer used for other transcript text.

In colour modes the block body uses a black background to read as one surface.
In monochrome the border characters carry the same grouping without pretending
a colour exists.

System entries use a `[sys]` label with the secondary colour, separate from
`you`, `agent` and `tool`. The label is a marker, not an authority change: the
text remains untrusted runtime narration.

## Consequences

The transcript no longer expands every tool detail by default, so a long Run
stays readable. The hidden-line count is explicit, so the model output is not
silently truncated by the UI. Clicking anywhere in the block is the same action;
Ctrl+T remains the keyboard path.

## Reassessment Conditions

Revisit if tools need per-line copy/selection, if a collapsed block must show
the tail rather than the head, or if a real scroll pane replaces the current
line-window renderer.
