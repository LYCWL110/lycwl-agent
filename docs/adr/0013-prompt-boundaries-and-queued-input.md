# ADR-0013: Prompt Boundaries And Queued User Input

- Status: Confirmed design
- Date: 2026-10-31
- Owner: [PROMPT_AND_USER_INPUT.md](../architecture/PROMPT_AND_USER_INPUT.md)
- Related: V1_CONTRACTS C01-C04, ADR-0010, RUNTIME_TOOL_CONTRACTS

Follow-up: [ADR-0014](0014-remaining-behavior-contracts.md) subsequently adopts
the seven remaining groups and discovery/queue details. On consumed ordinary
input it selects cancellation of all undispatched old-response calls and
revocation of unused grants, even for unchanged operations. The text below
records this earlier, narrower decision and its then-open deliverables.

## Context And Confirmation

The architecture comparison identified nine review groups. The user directed:
“将带审查部分添加，并按照你的意见确认第五项第六项”.
This confirms item 5 (prompt composition/project-rule boundaries) and item 6
(ordinary user messages during a Run). Groups 1-4 and 7-9 remain pending.
It does not confirm every detailed schema or authorize implementation.

## Evidence And Limits

This records observations from the preceding comparison, not a new source
audit or adoption of the references' entire implementations.

- OpenCode, `anomalyco/opencode`,
  `7ab721a97f383b89a8d901c87866b1565c1cfd9c`:
  `packages/core/src/session/instructions.ts:36-79` shows visible-history
  deduplication, sourced synthetic instruction content, and reinjection when
  prior content leaves visible history. `packages/core/src/session/prompt.ts`
  uses `SessionInbox` for user input. Parallel reads in that reference are not
  adopted by this serial V1.
- Miyu, `SHORiN-KiWATA/miyu-agent`,
  `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`:
  `crates/miyu-engine/src/agent/instruction_source.rs:1-59,135-138` separates
  dynamic facts from system-side behavioral instructions and considers changed
  or compacted-away visible blocks.
  `crates/miyu-core/src/state/conversation_db/queue/consume.rs` shows queued
  prompt consumption with transactional/checkpoint/journal records and
  running-turn/identity checks. Its database, daemon, and multi-Agent mechanisms
  are not adopted.
- Local *AI-Agents-in-Depth-zh-CN.pdf*: pp.67-69 discuss static prefixes,
  dynamic history and compaction; p.76 append-only facts/checkpoints; p.123
  project instruction documents; pp.156-158 queued, cancel, and parallel input
  strategies and safe processing boundaries. These are body page numbers
  (PDF page number is body page + 8), not mandatory schemas for this Harness.

The selected behavior is constrained by existing project decisions: one Agent,
one coordinator, JSONL event authority, serial tools, complete-response
validation, centralized permissions, immutable outcomes, and request-bound
disclosure consent. Early streamed-tool execution, parallel loops, persistent
interactive terminals, and fallback model switching are not adopted.

## Decision

The owning document specifies:

1. Separate trusted fixed rules, real user tasks, untrusted project materials,
   and dynamic Runtime facts by purpose and provenance. Project guidance
   cannot override permission, credential, or tool policy. Excluding repository
   application configuration does not settle project-instruction discovery.
2. Queue ordinary messages during a Run and consider them at complete-response,
   tool-return, and pre-dispatch boundaries. Re-evaluate affected pending
   actions, approvals, and disclosure bindings. Keep cancellation and matched
   question/authorization/resume commands distinct.

Exact discovery rules, prompt serialization, queue payloads/limits, races, and
restart/terminal handling still require detailed contracts. They are not
implicitly confirmed by this ADR.

## Alternatives And Tradeoffs

- Treating repository instructions as trusted system authority would make
  untrusted files able to bypass centralized policy; this is rejected.
  Completely excluding project guidance would lose useful project conventions.
  Sourced, untrusted guidance preserves usefulness with explicit boundaries.
- Cancelling on every ordinary message can interrupt useful work and create
  unnecessary unknown outcomes. Ignoring messages until a whole Run ends can
  dispatch stale actions. Queueing at safe boundaries is selected; it accepts
  that already-running work may finish before the message is considered.
- Parallel input handling would add coordination beyond V1. A separate
  cancellation command remains available for an actual stop request.

## Impact And Reassessment

Update AGENTS.md, baseline, C01/C02 references, Runtime contracts, and the review
index together. Pending proposals remain in `docs-check/`; per-tool JSON
Schemas remain partially confirmed and overall pending.

Reassess if concrete contracts cannot preserve timely input consideration,
replay, immutable approvals, or source provenance across compaction. Return
behavior-changing alternatives to the user rather than weakening these rules.
Documentation only: no feature implementation, dependency installation, Git
operation, credential access, paid request, native probe, or engineering-gate
closure is authorized.
