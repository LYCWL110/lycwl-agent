# ADR-0072: Visible Input Queue And Tool Details

- Date: 2026-11-08
- Status: Authorized by the user's TUI correction request
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BEHAVIOR_CONTRACTS supplement B
- Related: ADR-0013/0014/0065; V1_CONTRACTS C01/C02/C06

## Context

Runtime already recorded queue acceptance and consumption, but the transcript
ignored both. A message could leave the composer without visible acknowledgement.
Tool reception and completion were rendered as separate full transcript entries,
making tool output dominate the conversation.

## Decision

S02 owns display states and interaction details. Render accepted queue entries
from events immediately; update that same entry as consumption, main-request
inclusion and the matching validated response arrive. Consumption is not sending.
Add optional includedInputIds to the internal main model-request start event.
Auxiliary requests do not supply main-request acknowledgement; old events without
the field remain conservative. Interrupted sends stay unknown, and unsent input
on terminal Runs stays retained for review. Rejected queues preserve drafts.

Merge a tool's lifecycle into one Run/toolCallId-scoped entry. Render a compact
summary by default and expose recorded parameters/result/error details through
mouse click or Ctrl+T. Details remain scrollable and terminal-safe. No hidden
payload read, replay, new tool, dependency, generation request or network access
is introduced. Approval previews remain separate, complete and explicit.

## Alternatives And Consequences

Optimistic sent labels and treating consumption as delivery would overstate the
evidence. Hiding all tools removes useful progress; always-expanded output makes
the conversation hard to scan. Event-derived status and local expansion preserve
both clarity and inspectability, with keyboard fallback for mouse-less terminals.
The optional internal field is not a complete external Schema adoption or a
proof of wire-level receipt without a matching complete response.

## Validation Boundary

Use fake providers, deterministic event/controller/recovery regressions and Ink
input-stream tests for queue visibility, ordering, incomplete send states, reject
paths, status merging, expansion, paging, narrow viewports and pasted mouse reports.
Actual paid calls, full Windows Terminal usability and G05/G08 acceptance remain
outside this change. No automatic queue execution or permission expansion follows.
