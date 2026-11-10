# ADR-0065: Transcript Wheel And Command Suggestions

- Date: 2026-11-06
- Status: Authorized by the user's correction request; implemented
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE section 9
- Related: ADR-0062, ADR-0064

## Problem

The alternate screen has no terminal scrollback. The transcript supported
keyboard paging but did not capture mouse wheel reports, making earlier
messages inaccessible through the expected wheel interaction. The composer
also gave no command suggestions when the user entered a slash.

## Decision

Capture SGR mouse reports only while the main interactive TUI is mounted.
Observe the same stdin bytes that Ink parses, without replacing its keyboard
parser or using private Ink APIs. Ink continues filtering mouse reports out
of ordinary input. Its public usePaste hook enables bracketed paste, keeping
pasted reports and carriage returns out of navigation/submission actions.
Wheel events over the transcript scroll three display
lines; clicks, releases, horizontal wheels and reports over the composer
do not submit, answer or approve anything. Reset mouse reporting on unmount,
configuration handoff and normal process exit. Add no dependency.

Keep PgUp/PgDn, add Ctrl+Home/Ctrl+End, and clamp both scroll boundaries.
An earlier viewport stays anchored while new messages append. Reaching the
bottom resumes following new content. Scrolling changes only presentation,
leaving the draft and Session/model history intact.

Show the existing /config command and an English description for matching
slash input. Tab completes the command, Enter submits the selected command
and Escape dismisses suggestions before quitting. Mark configuration
unavailable during a Run, preserving the draft instead of queueing a command.
Do not intercept slash text in question or approval replies. Suggestions
reserve screen rows so the transcript, input and footer remain visible.
This is a list of implemented commands, not a general slash/plugin framework.

## Verification And Remaining Work

Tests cover real Ink input streams, wheel reports, draft preservation,
mouse cleanup, both paging boundaries, anchoring after appended messages,
English suggestions, completion, unavailable configuration and literal
question answers. Decoder cases cover split reports, modifiers, malformed
input and bracketed paste. Layout checks include 40x12, 80x24 and 120x40.

These checks do not close G08. Full Windows Terminal visual, focus, resize
and emergency-shutdown validation remains outstanding.
