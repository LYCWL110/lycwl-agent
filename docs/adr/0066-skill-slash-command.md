# ADR-0066: `/skill <id>` As A Run-Launching Command

- Status: Implemented and verified locally
- Date: 2026-11-08
- Related: ADR-0064 (skill activation), P03

## Context

ADR-0064 added the `skill` tool for model-initiated activation and recorded that
`/skill` was specified but not parsed. P03 named two activation paths; only one
existed.

## Decision

`/skill <id>` starts a Run with the skill body injected.

### Why a Run rather than a bare injection

The user chose "start a Run" over "inject without executing". A skill is a procedure;
loading one without a task would leave the model holding instructions for nothing, and
it would need a Run lifecycle that has no task — a state the Runtime does not have and
does not need.

The command therefore behaves as a task input: the body is injected as a user message
with its provenance header, then the task text follows. That ordering is asserted,
because a body after the task would read as an afterthought rather than a briefing.

### Refusals happen before the Run exists

A missing skill, an invalid id or an unwired loader refuses before `startRun` builds a
context. `run` rejects with the safe code, matching how it already reports a closed or
busy session.

This matters for honesty: a Run that started and then failed would leave an event
trail implying work began. Nothing was attempted, so nothing is recorded.

### Command parsing

The generic rule that rejects trailing arguments for every command except `/session`
now also excepts `/skill`. The id is validated at the command layer as well as in the
loader, so a malformed id is a command error rather than a Run that fails at the tool.

`/skill` is `idleOnly`, like `/config` and `/init`: changing what a Run is working from
while it runs would not affect the current Run anyway.

## Verification

- 1590 tests pass across 317 suites.
- Eight tests cover: the intent carrying `skillId`, a missing id, three invalid id
  shapes, refusal while a Run is active, the body preceding the task with its
  provenance header, a missing skill refusing with no model request made, an unwired
  loader refusing, and an ordinary Run injecting nothing.
- `pnpm run verify` typecheck passes; lint exits 0 at the existing baseline.

## What This Still Does Not Do

- **No TUI catalog view.** A user must know the skill id; nothing lists them.
- **No preview before execution.** The user cannot see what a skill will inject before
  committing to a Run.
- **The injected body is not deduplicated** against a previous activation in the same
  Session, so loading the same skill twice sends it twice.
- **No refresh**: the body is read from disk at activation, so a file edited mid-Session
  is served with its new content while the catalog block still shows the old
  description.

## Consequences

- Both activation paths named by P03 now exist.
- The refusal-before-start rule keeps a failed command from looking like a started Run.
- The absence of a catalog view is the remaining usability gap, not the mechanism.

## Reassessment Conditions

Add a catalog view before expecting a user to discover skills unaided. Revisit
deduplication if repeated activation proves wasteful in practice.
