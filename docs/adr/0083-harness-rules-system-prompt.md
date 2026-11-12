# ADR-0083: Send fixed Harness rules as the system prompt

- Status: Accepted (2026-11-08)
- Related: ADR-0013 (prompt provenance), ADR-0044 (AGENTS.md as untrusted), ADR-0081 (completeness)

## Context

All three provider adapters accept a system prompt — `system` for Anthropic and Chat
Completions, `instructions` for Responses — and the composition root never passed
one. The model received no application rules at all.

Everything it knew came from either the tool schemas or the user turn. That is not
nothing: the tool catalog describes the tools, and AGENTS.md arrives as a sourced
untrusted turn. But no text told the model that every mutation needs approval, that
a denied call should not be repeated, that an edit which fails to compile is
reverted, or that a tool result may carry injected instructions. Those are product
rules, and they were absent.

The Claude Code snapshot (`src/constants/prompts.ts`) shows a working structure for
this: fixed sections assembled in a stable order, with anything session-dependent
kept out of the cacheable prefix. The content here is written for this Harness, not
copied.

## Decision

`domain/context/harness-rules.ts` holds six fixed sections — intro, environment,
doing-tasks, acting-with-care, using-tools, tone — rendered into one string and
passed to `assembleRuntime` as `system`.

### This is the only text with application authority

Project material, tool results and web content stay untrusted and arrive as sourced
user turns (ADR-0013, ADR-0044). The system prompt is fixed at build time and
carries no project-specific content, which is asserted in tests.

### Content matches real capabilities

A rule naming a tool the Harness does not expose makes the model call something that
fails, which is worse than saying nothing. The tests assert that the rules name only
tools that exist, and that they do not mention subagents, hooks, output styles or
plan mode — features of the reference project that this Harness does not have.

### The whole prompt is cacheable

Every section is constant per build, so nothing here can invalidate the cached
prefix on a later turn. The version constant is the honest way to record that the
text changed.

## Consequences

- `assembleRuntime` gains an optional `system` and forwards it as `system` or
  `instructions` per protocol.
- `runtime-selection.ts` renders the rules and passes them, so the composition root
  stays the only place deciding what reaches the model with authority.
- Four existing tests asserted `body.system === undefined` to prove that guidance,
  skills and impersonation attempts never become a system prompt. That assertion
  passed for the wrong reason once the field became non-empty: it would also have
  passed while the rules were missing entirely. They now assert that the specific
  untrusted text is absent from the system field, which is the property they were
  always trying to state.

## Known limitations

- **The prompt is static.** It does not adapt to the enabled tool set, the model, or
  the session mode. A session without `--write` is still told that mutations need
  approval, which is true but not the whole truth: they are unavailable.
- **No language preference or output style.** Those exist in the reference and would
  each be a session-dependent section, which the cacheable-prefix design deliberately
  excludes from this fixed block.
- **The rules are unmeasured.** Whether they improve task success on the target model
  has not been tested; they encode product rules, which is a correctness requirement
  rather than an optimization.

## Reassessment conditions

Reopen if a session mode needs different rules, if a rule is found to contradict real
behaviour, or if the prompt's presence is measured to affect task outcomes.
