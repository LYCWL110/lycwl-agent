# ADR-0058: Enabling Shell Behind An Explicit Flag

- Status: Wired and verified locally; **G02 remains OPEN**
- Date: 2026-11-05
- Related: ADR-0042 (write opt-in), V1_BASELINE section 5, STAGE2D_PROCESS_G02

## Context

Shell, the background tools and the Job Object supervisor were implemented and
tested — including 200 race runs — but the composition root passed
`enableProcesses: false`, so the agent could not run a command. For a coding agent
that means it cannot run tests, which is a large part of the job.

## Decision

Expose shell and the background tools behind `--shell`, and record the dependency on
G02 honestly.

### Flags

`--shell` enables process execution. It **implies write mode**, because a read-only
Session refuses Shell by design; making the flag silently do nothing would be worse
than the small convenience of not requiring both.

Every command still needs its own one-shot approval. The approval prompt shows the
exact command and working directory, and the launch summary says shell is enabled.

### Honest limitation, stated at the flag

An approved command runs with the current Windows user's full permissions. **V1 has
no OS sandbox.** The help text says so, and so does the plan that owns this slice.

### G02 stays open

The supervisor implements the required shape — Job Object with kill-on-close,
suspended creation, assign-before-resume, terminate-on-assignment-failure — and its
tests pass on this host. That is evidence, not a closed gate:

- G02 covers the full Windows Job/pipe/handle supervision contract, including
  recovery and resource behaviour that this project has not independently audited;
- the 200-race run is one machine, one Windows build;
- background output still reads the whole capture file and slices, so peak memory is
  not bounded by page size.

The gate is recorded as open in ADR-0001 and the baseline. Enabling the tools does
not close it.

## Verification

- 1209 tests pass across 266 suites; the vitest suite runs 12 render tests.
- Six shell tests drive real commands through the real supervisor:
  - an approved `echo` runs and its output is returned;
  - a denied command produces no side effect (the file it would have written does
    not exist);
  - a non-zero exit is reported as `failed` with `nonzero_exit`;
  - shell and the background tools are absent from the advertised catalog when the
    flag is off, and present when it is on;
  - calling a disabled shell returns `tool_unavailable_in_build`.
- `pnpm run verify` exits 0.

## A Correction

My first shell test used a read-only Session and expected the command to run. It
failed with `read_only_session`. That refusal is the confirmed design — AGENTS.md
says a read-only Session rejects Shell until the user switches to workspace-write —
so the test was wrong, not the code. The test now uses write mode and the entry point
makes `--shell` imply it.

## What This Still Does Not Do

- **LSP and web tools remain disabled**; only shell and background are exposed here.
- **No sandbox.** A command can do anything the user can.
- **Background output is not streamed incrementally from disk**; it reads the capture
  file and slices.
- **LSP is not under the Job Object**, so a Harness crash does not guarantee its
  process tree is terminated. That gap predates this change and is unrelated to
  shell, but it means "supervision" is not uniform across tools.
- No streaming of model output.

## Consequences

- The agent can run tests and commands, which is the difference between reading code
  and working on it.
- The safety story is unchanged: approval per command, no sandbox, no automatic
  retry of an unknown outcome.
- G02's open status is stated next to the feature rather than in a distant document.

## Reassessment Conditions

Do not describe shell as G02-validated. Close G02 only with the full supervision
evidence the baseline requires, including recovery and bounded-memory output.
