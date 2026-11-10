# ADR-0035: Local Verification Command And Architecture Policy Checks

- Status: Adopted. Replaces the earlier CI-pipeline form of this decision.
- Date: 2026-11-05 (supersedes the CI version of the same date)
- Related: V1_BASELINE.md section 11; AGENTS.md Development/Testing/Acceptance

## Context

I added a GitHub Actions pipeline, then checked whether it could ever run:

```
git remote -v   →  (empty)
```

The repository has no remote and has never been pushed. GitHub Actions does not
run locally, so the pipeline could not execute at all. It was infrastructure for a
collaboration model this project does not use: one developer, one machine, all
local.

A second finding was separate and worth keeping: `pnpm run lint` was failing with
8 formatting/import-order errors in recently touched files, so "the checks pass"
was true only of the commands run individually.

## Decision

Remove the CI pipeline. Keep and strengthen the local verification path.

### Removed

`.github/` is deleted. No CI runs, and none is claimed.

### Added: one local command

`pnpm run verify` runs, in order: lint, typecheck, test-presence check,
architecture boundaries, the 980-test suite, and the vitest TUI suite.

### Added: a test-presence guard

`tools/require-tests.mjs` fails when no `*.test.ts` exists under `tests/`. This is
not decoration:

- `.gitignore` excludes `tests/`, and `git ls-files tests` returns 0 files;
- `node --test "tests/**/*.test.ts"` with no matching files **exits 0 while
  running nothing**.

So a fresh clone would show a green test step that verified nothing. The guard
converts that into an explicit failure. It resolves the path from its own location
rather than the caller's cwd, so it behaves the same from any directory, and both
the present and empty cases are verified.

### Kept: lint baseline repair

The 8 errors are fixed. `lint` exits 0 with 1 warning and 139 infos, matching the
pre-existing baseline. The infos are `useLiteralKeys`-class suggestions that
predate this work.

### Kept: architecture policy checks

`tools/architecture-boundary.ts` already enforced layer imports, no `node:` in
domain/application/ports, path containment and cycle freedom. Two rules were added
because the codebase now depends on them:

- **Pure layers** (`contracts`, `domain`, `ports`) must not use `process.env`,
  `Date.now()`, `new Date()`, `Math.random`, `require("node:...")` or a dynamic
  `node:` import. This is what makes prompt rendering and policy decisions
  reproducible; trusting it was not enough.
- **Non-executing layers** (`tui`, `contracts`) must not reference
  `child_process` or its sync spawn/exec helpers. A render path that could execute
  a tool would make the interface an authority rather than a view.

The scan found zero existing violations, so this tightened the rules without
forcing unrelated edits.

## Consequences

- There is exactly one way to verify this project, and it runs locally.
- A missing test tree now fails loudly instead of passing silently.
- No claim is made that any remote check exists.
- If the project later gets a remote and a second contributor, a pipeline becomes
  worth adding; at that point the decisions to revisit are the remote itself and
  whether `tests/` should be tracked. Neither is implied by this ADR.

## Reassessment Conditions

Revisit only when there is a real remote and more than one contributor. Until
then, CI would be configuration that never runs.
