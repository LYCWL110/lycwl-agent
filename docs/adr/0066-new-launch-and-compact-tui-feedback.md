# ADR-0066: New Launch And Compact TUI Feedback

- Date: 2026-11-06
- Status: Authorized by the user's correction request; implemented
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE sections 7/9
- Related: ADR-0054, ADR-0055, ADR-0064, ADR-0065
- Pre-change source commit requested by the user: d17719f

## Problem

The entry point derived one Session ID from the workspace path, automatically
rebuilding old context on each launch. This contradicted the user's expectation
that opening the program starts a new conversation. The slash suggestions also
added wrapped rows to the input layout, and the UI gave no animated model
activity feedback.

## Decision

Each ordinary launch creates a random Session identity. All turns and
configuration reloads within that launch retain that identity and conversation.
Do not delete or rewrite old records. Only --resume followed by an explicit,
filesystem-safe Session ID selects earlier records. Reject missing, ambiguous,
path-like and reserved-device arguments. Print the selected identity at startup.
This supersedes ADR-0054's workspace-derived default; its durable storage and
ADR-0055's explicit history reconstruction remain.

Display implemented commands in a compact overlay directly above the input.
Use one row per command, aligned names and short English descriptions, a full
selected-row highlight and monochrome inverse fallback. Do not allocate extra
transcript rows or move the input when suggestions open. Preserve filtering,
keyboard selection/completion, unavailable configuration and literal question
answers. This adds no commands copied from the reference's excluded features.

Derive Thinking and Working from recorded model-request/response and tool
events. Animate a fixed nine-cell bidirectional scanner only while activity
is present. Waiting, cancellation and terminal state remove the animation
subscription. Static rendering remains possible with animations disabled.
The indicator is execution feedback; it does not expose or infer model reasoning.

## Reference Review

Reviewed anomalyco/opencode at the existing locked revision
7ab721a97f383b89a8d901c87866b1565c1cfd9c using GitHub's contents API:

- packages/tui/src/component/prompt/autocomplete.tsx: absolute menu placement,
  separate display/description, selection background and clipped single rows.
- packages/tui/src/component/prompt/index.tsx: running-only footer scanner.
- packages/tui/src/ui/spinner.ts: fixed-width bidirectional scanner with a trail.
- packages/tui/src/component/spinner.tsx and spinner-frames.ts: animation
  activation, cadence and cleanup.
- LICENSE: MIT, copyright 2025 opencode.

Adopt interaction/design principles and implement them independently with the
existing Ink/React APIs and palette. No OpenCode source or dependency is copied.
The screenshot is a visual reference, not adoption of OpenTUI, multi-agent,
MCP, editor or other reference commands.

## Verification And Remaining Work

Local TLS fixtures verify two ordinary launches over the same workspace and
data directory stay isolated, same-launch turns retain answers, and explicit
resume reads the selected earlier Session. Unit cases cover argument safety
and activity derivation. Ink tests cover stable input coordinates, single-row
suggestions, animation changes and absence of further animation frames during
waiting/completed/cancelled states. Existing wheel, draft, configuration,
approval/question and terminal-cleanup tests remain applicable.

Tests do not use paid Provider requests or the user's real conversation records.
G08 manual Windows Terminal visual and emergency-exit acceptance remains open.
The requested pre-change commit excludes docs/tests/AGENTS under the repository's
existing ignore rules. This request does not change those rules.
