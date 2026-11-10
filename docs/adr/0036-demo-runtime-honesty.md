# ADR-0036: Demo Runtime Honesty — No Fabricated Success, No Silent Sensitive Read

- Status: Confirmed fix of two defects in the demo entry point
- Date: 2026-11-05
- Related: C06; AGENTS.md read-approval policy

## Context

`lycwl` currently runs `createDemoRuntime`. While assessing how far the project is
from usable, I examined that entry point and found two behaviours that undermined
it. I also had to correct an earlier claim of mine, which is recorded here because
the correction matters more than the original mistake.

### Correction: the approval gate was not bypassed

I previously reported that approvals were "short-circuited into auto-approve".
That was wrong. `suspendOnApproval: true` sets `deferApprovals`, so an
approval-required tool suspends and waits; the injected `ApprovalGate` is never
consulted on that path. A probe confirmed it: the Run hangs, `pendingApprovalView`
returns the pending tool, and nothing is approved automatically.

### Defect 1: a tool reported success for work it never did

`DemoTools.write_note` returned:

```ts
{ status: "succeeded", text: "write_note: demo write accepted (no file touched)" }
```

The demo runtime has no filesystem adapter. So the user could approve a write, be
told it succeeded, and find the file untouched. That breaks the one chain the
approval system exists to make trustworthy: approve → execute → observe. A
fabricated success is worse than an error, because an error is visible.

### Defect 2: sensitive reads were silently approved

`read_file` declares `requiresApproval: false` because ordinary reads need no
prompt. But `runReadFileFlow` calls `ApprovalGate.decide` itself when the resolved
target is sensitive or outside the workspace — `.env`, `.git`, `.vscode`, paths
outside the root. The demo passed `decide: async () => "approved"`, so those reads
were approved unconditionally by a gate with no user attached.

That is a real hole in a confirmed boundary, not a demo nicety.

## Decision

- `write_note` now fails with `demo_tool_does_not_write`. Approving it produces a
  visible failure rather than a false success.
- Both `ApprovalGate` instances in the demo runtime deny. The inline gate is used
  exactly for sensitive reads, and there is no interactive channel wired to it, so
  denying is the only honest answer. Approvals for tools that require one still
  suspend normally and reach the TUI, which is unaffected.

Verified by probing the real composition root: `.git/config` returns
`approval_denied`, while `package.json` still reads normally.

## What This Does Not Do

- The demo runtime still cannot write anything. That is now visible instead of
  disguised; making it write needs a real adapter and an enabled write path.
- Denying the inline gate means sensitive reads are simply unavailable in the demo
  runtime. Wiring them to the TUI would require routing `read_file`'s internal
  approval through the coordinator's suspend path, which is a design change, not a
  one-line fix.
- No real Provider exists on `main`, so `lycwl` still cannot call a model.

## Consequences

- The approve → execute → observe chain is honest in the one entry point that
  exists.
- A sensitive read in the demo runtime fails closed instead of leaking.
- Two tests pin both behaviours, so a future "helpful" auto-approve cannot return
  quietly.

## Reassessment Conditions

Route sensitive-read approval through the coordinator when there is an interactive
channel for it. Do not restore an unconditional approve gate for any reason.
