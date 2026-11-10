# ADR-0049: TUI Replies Await The Run, Not settle()

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0048

## Context

ADR-0048 made `ask_user` reachable by the model, and recorded that the TUI had no
question flow wired to the real runtime. Checking that claim found the flow *was*
wired — and broken.

`TuiController.answer` and `.approve`/`.deny` replied to the coordinator and then
awaited `coordinator.settle()`. But `settle()` only resolves the continuation created
by `resumeRun`. For an approval or question reply it returns `null`, so the controller
applied nothing: the view stayed on the pending panel after the user had answered,
and `lastResult()` never updated.

The Run itself completed correctly; only the UI was wrong. That is the worst kind of
bug to leave in place, because the coordinator tests all pass.

## Decision

The controller tracks the in-flight `run()` promise and awaits **that** after a
reply.

```ts
let activeRun: Promise<CoordinatorResult> | null = null;
```

`submit` stores the promise, awaits it, and clears it only if it is still the current
Run. `settleActiveRun()` awaits the stored promise after a reply and applies the
result. A later Run starting before an earlier one settles cannot clear the newer
promise, because the identity is compared before clearing.

`settle()` remains correct for its actual purpose — awaiting a `ResumeRun`
continuation — and is not used for replies.

## Verification

- 1101 tests pass across 241 suites; the vitest suite runs 12 render tests.
- A question test drives the real controller: the view shows `waiting: question` with
  both options, `answer("a")` completes the Run, the recorded `question_answered`
  text is the label `src/a.ts`, and the view is no longer waiting.
- An approval test drives the real controller with a mutating tool: the view shows
  `waiting: approval`, `deny()` completes the Run, a `tool_execution_denied` event is
  present, and the Run status is `completed` rather than `failed`.
- `pnpm run verify` exits 0.

Both tests failed before the fix with `actual: null, expected: "approval"` and an
unsettled view, which is what pinned the defect.

## What This Still Is Not

- **The demo runtime is what `lycwl` runs when unconfigured**, and it never suspends
  on a real model question because its provider is scripted. The flow is proven at
  the controller level and against a scripted provider, not against a real model.
- **`answer` for a choice passes the typed text as an option id.** A user must type
  `a`, not the label. The panel lists ids and labels, but the mapping is positional
  and undocumented in the UI. That is a usability gap, not a correctness one.
- No free-text or confirmation panel behaviour beyond the existing mapping.
- No streaming.

## Consequences

- After answering a question or deciding an approval, the user sees the outcome
  instead of a stale panel.
- The distinction between `settle()` (resume continuation) and the Run promise
  (reply outcome) is now explicit in the controller rather than assumed.
- A test that drives the controller end to end exists, so this class of bug cannot
  return silently.

## Reassessment Conditions

Wire the choice answer to accept a label or an id, and show which is expected, when
the question panel gets real UX work. Do not reintroduce `settle()` for replies.
