# ADR-0095: Two-Option Approval Control With Enter Confirmation

- Status: Accepted (2026-11-25)
- Related: ADR-0021 (approval boundaries), ADR-0048 (ask-user reachability), ADR-0094 (web default)

## Decision

A pending tool approval shows two visible actions, `Approve` and `Cancel`.
Left and right arrows move the selection; Enter confirms the focused action. A new
tool approval starts with `Approve` selected. A sensitive-context redisclosure
starts with `Cancel` selected because it sends context to a new destination.

Selection is not a reply. The Run remains suspended until Enter is pressed, and
there is no always-allow control. The existing `a` and `d` shortcuts select the
corresponding action; Enter still confirms it.

While a decision is pending, the composer is replaced by an approval box. The
text input is hidden and disabled, so ordinary typing cannot be mistaken for an
approval or queued behind the wait. Input returns only after Approve or Cancel is
confirmed. Scrolling keys still reach the operation preview.

An approval whose exact preview could not be recorded has no actionable
`Approve` button. `Cancel` is selected, and Enter denies.

## Consequences

The decision is visible instead of being encoded in a typed word, and the
default path is one Enter keypress. A stray Enter can approve a tool call while
the approval box is focused, which is the explicit cost of the requested default.
Queueing a follow-up waits until the decision is made.

## Reassessment Conditions

Revisit if approval needs more than two actions, if a keyboard-only confirmation
must be separated from the default selection, or if queued input during a wait is
required again.
