# ADR-0047: Compaction Bodies Carry Real Text

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0046

## Context

ADR-0046 recorded a defect: the summarisation prompt rendered member ids instead of
text, so `full` representation was a lie. The summariser was told a group was fully
available while receiving only identities like `tool_result:c1 (succeeded)`.

That defeats the purpose of compaction. A summary built from ids is a summary of the
shape of a conversation, not of its content.

## Decision

Render real bodies according to the plan's representation.

| Representation | What is sent |
| --- | --- |
| `full` | the actual text the model originally saw |
| `excerpt` | head 400 units, an explicit truncation marker, tail 200 units |
| `reference_only` | nothing; the skeleton already states the body never entered |

The excerpt marker names how much was removed, so a summariser cannot present a
clipped body as if it were complete.

### A second defect this exposed

The first attempt at `full` still failed the assistant-text case. Cause:
`buildGroups` created **no message member for an assistant turn**, so the group's
body consisted only of call/result pairs and the model's own text was never
renderable at all.

That is worse than a rendering bug — the content was absent from the group's
definition, so no renderer could have recovered it. Fixed by adding a `message`
member when the assistant turn has text. A group now reads
`message, tool_call, tool_result`, and the existing structural test was updated to
assert three members rather than two, because the old count was asserting the bug.

### Locating the right text

`messageTextFor` originally returned "the first user text" for any group, which gave
assistant groups the wrong content. It now selects by group kind and consults the
group's seq to disambiguate repeated turns of the same kind.

This is positional rather than id-linked, which is a real limitation: member ids for
messages are synthetic (`m1`, `m3`) and carry no back-reference into the
conversation. A future change that reorders groups would need this revisited; the
current construction order makes it correct.

## Verification

- 1095 tests pass across 238 suites; the vitest suite runs 12 render tests.
- Five tests pin the behaviour: tool result text is present, assistant text is
  present, user text is present, a `full` body never carries a truncation marker,
  and a degraded representation either quotes with a marker or contributes nothing.
- `pnpm run verify` exits 0.

## What This Still Is Not

- **The replacement turn is still a rendered summary**, not the original bodies. The
  artifact becomes `[context-summary]` plus recent turns; original text is
  summarised, not re-sent. That is what compaction is for, but it means a summary is
  the only record the model keeps of those turns.
- **Excerpt bounds are fixed** (400/200) rather than derived from the remaining
  budget, so an excerpt is bounded but not adaptive.
- **No real-model validation.** Whether a real summariser produces a good artifact
  from real bodies is untested.
- Constraint coverage still validates against an empty set.

## Consequences

- `full` now means what it says, and the summariser receives content rather than an
  inventory.
- The assistant-text absence is fixed at the grouping layer, which also benefits any
  future consumer of groups.
- The positional text lookup is documented as a limitation rather than left implicit.

## Reassessment Conditions

Link message members to conversation indices explicitly before allowing group
reordering. Derive excerpt bounds from budget when the tokenizer is real.
