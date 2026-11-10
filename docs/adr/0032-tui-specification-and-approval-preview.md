# ADR-0032: TUI Specification Layer And Authoritative Approval Preview

- Status: Confirmed implementation of already-confirmed S02 design
- Date: 2026-11-05
- Related: V1_DESIGN_SUPPLEMENTS.md S02; G08; C01/C02; P03

## Context

S02 specifies what each TUI panel must show and which actions must stay distinct.
The existing TUI was 199 lines: it could render a transcript, a todo list and a
minimal approval prompt, but it had no specification layer, no queue view, no
four-dimensional report and no Skills panel.

The most concrete gap was in the approval panel: it showed a tool name and
"type a to approve" but **not the recorded preview**. Approving without seeing the
exact command and working directory is not informed consent, and the contract is
explicit that a preview must not conceal or alter the actual arguments.

## Decision

### Specification layer (`src/tui/spec.ts`)

A pure module that encodes the parts of S02 that can be tested without a terminal:

- `PANEL_ACTIONS` gives every panel an explicit action set, and `close_panel` is
  the only action that keeps the wait. Approval, question and disclosure panels
  share no approval action id, and `resume_run` exists only in the recovery panel.
- `DISTINCT_ACTIONS` names the four actions a generic "continue" must never stand
  in for: `reply_approval`, `reply_disclosure`, `submit_user_input`, `resume_run`.
- `acceptApprovalReply` rejects a version mismatch and rejects a reply when the
  operation's preconditions changed **while the preview was being read**. That
  second check is the point: the preview the user read no longer describes the
  operation, so the reply cannot stand.
- The approval model records `focusGrantsNothing: true` and
  `alwaysAllowAvailable: false` as literal types, so "focused" cannot be mistaken
  for "approved" and no always-allow control can be added without changing a type.
- `buildQueueView` allows withdrawing only `accepted` items and reports
  `hasConsumedNotSent`, because "consumed" is not a promise the model saw it.
- `describeRunVersusGoal` keeps the Run lifecycle and goal verification separate
  and appends still-running background task count.
- `displayWidth` / `truncateToWidth` treat CJK and fullwidth characters as two
  columns, which is what makes `text.length` truncation cut a line in the wrong
  place. This is an approximation, not a Unicode width table, and it says so.

### Authoritative preview

`deriveApprovalPreview` reads the `safePreview` from the recorded
`approval_requested` event for the pending approval id. It does not read local
state and it does not build a preview.

A mismatch yields `null`, and the panel then renders
"preview unavailable: the exact operation is not recorded" with no invitation to
approve. That is deliberate: a panel that cannot describe the operation must not
look approvable. A stale local copy silently becoming the thing the user approves
is exactly the failure this avoids.

## What This Is Not

- **Not a visual prototype and not a usability test.** G08 (Windows terminal
  safety) remains open: resize, focus changes, paste, repeated keys and control
  characters are specified here but not verified in a real Windows Terminal.
- The approval panel renders the preview as plain lines. Scrolling, focus
  management and keybinding conflicts are modelled (`scrollable`,
  `preconditionsChanged`) but the interactive behaviour is not implemented.
- No Skills panel is rendered yet, and no provider-support panel exists, because
  there is no provider matrix to show (ADR-0018).
- No recovery panel is rendered; the recovery facts exist in the domain but are not
  projected.

## Consequences

- The approval panel now shows what the Runtime actually recorded, and refuses to
  look approvable when it cannot.
- The distinct-action rule is executable: a future shortcut that aliases
  "continue" to an approval fails a test rather than a review.
- Wide-character truncation is correct for CJK instead of cutting bytes.

## Reassessment Conditions

Revisit the width approximation only with a real Unicode width table and evidence
it matters. Do not relax the null-preview behaviour: an approvable-looking panel
without a recorded preview is the defect.
