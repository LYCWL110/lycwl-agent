# ADR-0064: Alternate Screen And Session Continuity

- Date: 2026-11-06
- Status: Authorized by the user's report and correction request; implemented
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE sections 3/7/9
- Related: ADR-0054, ADR-0055, ADR-0062, ADR-0063; V1_CONTRACTS C03/C04

## Problem

The application rendered into the primary terminal buffer instead of entering
a separate program screen. Successive messages also lost both visible history
and the immediately preceding model conversation: the TUI replaced events with
the latest Run, and each Run restarted from the immutable launch-time history.
Restart recovery existed, but did not fix consecutive messages in one launch.

## Decision

Use the installed Ink 8 alternateScreen option for both the main TUI and
configuration. Let Ink restore the primary screen and cursor on unmount and
process exit. Retain ordinary noninteractive output for help/version commands.
No terminal dependency or manually managed ANSI lifecycle is introduced.

Keep one Session identity for each coordinator's lifetime when no explicit
sessionId is supplied. Seed its conversation from priorConversation once.
Each terminal Run commits its actual conversation for the next Run, retaining
assistant replies, tool pairs and compaction results without re-executing
historical operations. Current guidance is injected at the next Run boundary
rather than accumulated repeatedly. Waiting does not commit or auto-resume.

The controller accumulates recorded events by eventId across Runs and includes
live events without duplication. Waiting for a new reply preserves the previous
transcript. Separate Run identities, budgets and permission decisions remain.

## Verification And Remaining Work

Tests cover three successive turns in both the model request and transcript,
history while the second reply is pending, tool-call/result/final-answer
continuity, stable Session identity with distinct Run identities, and actual
Ink alternate-screen enter/exit sequences over test terminal streams.
Existing question/approval, cancellation, configuration-resume, checkpoint
and restart-history tests remain applicable.

Full Windows Terminal visual and emergency-shutdown validation remains part
of G08. This adds no session picker, cross-session cache or automatic recovery.
Provider configuration changes still use the existing reload/rebuild path.
