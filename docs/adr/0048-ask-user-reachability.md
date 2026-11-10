# ADR-0048: Making ask_user Reachable By The Model

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0041

## Context

ADR-0041 recorded that `ask_user` could not be called by the model: the coordinator
special-cased the tool name, but `executeToolCall` checked `getDefinition` **first**
and returned `unknown_tool` before that branch could run. `ask_user` has no tool
executor, so the lookup was always null.

The demo runtime hid this, because it registers its own fake `ask_user` definition.

## Decision

### Ordering

Skip the definition lookup for `ask_user`, since the coordinator answers it:

```ts
const definition =
  call.toolName === ASK_USER_TOOL ? null : dependencies.tools.getDefinition(call.toolName);
if (call.toolName !== ASK_USER_TOOL && definition === null) { ... }
```

A genuinely unknown tool still fails with `unknown_tool`; a test asserts both cases.

### Catalog membership

`availableTools` filters by whether a tool is registered, which would exclude
`ask_user`. The filter now treats coordinator-answered tools as always available,
through a shared `COORDINATOR_TOOL_NAMES` constant rather than a scattered string.

### A second defect: the answer was opaque

The question's answer was returned as `{"optionIds":["b"]}`. An option id tells the
model nothing about what the user chose: `b` could be any of the offered labels.

`validateUserAnswer` now returns the **label** for a single choice and a
`{ selected: [{ id, label }] }` object for a multiple choice. The id alone was
technically correct and practically useless, which is the kind of defect a passing
schema test does not catch.

## Verification

- 1098 tests pass across 239 suites; the vitest suite runs 12 render tests.
- One integration test drives a real Run: the model calls `ask_user`, the Run
  suspends on the question rather than failing, the answer arrives as a
  `tool_result` carrying the label the user saw, and **no approval is requested** —
  a question is not permission.
- Two tests assert the negative cases: a malformed `ask_user` argument fails the tool
  call, and a genuinely unknown tool still reports `unknown_tool`.
- `pnpm run verify` exits 0.

## What This Still Is Not

- **The TUI has no question flow wired to the real runtime.** `TuiController` can
  submit an answer, and the coordinator suspends correctly, but nothing in the real
  entry point routes the question panel. Asking works in the coordinator and in
  tests; whether a user sees the prompt depends on wiring not done here.
- Choice answers lose the id when there is exactly one selection. That is deliberate
  for readability, but a caller that needs the id back must ask differently.
- No validation that the model's question is well-formed beyond the existing
  `validateAskUserQuestion` rules.
- No streaming, and three of four protocols remain unimplemented.

## Consequences

- A model in a real session can now ask the user a question and receive a usable
  answer.
- The answer text changed shape, so tests that asserted `{"optionIds":...}` were
  updated — the old expectation was asserting the defect.
- The demo's fake `ask_user` definition is no longer needed to make the feature
  appear to work, though it remains.

## Reassessment Conditions

Wire the question panel into the real TUI before claiming interactive questions work
end to end for a user. Revisit the single-choice id omission only with a caller that
needs it.
