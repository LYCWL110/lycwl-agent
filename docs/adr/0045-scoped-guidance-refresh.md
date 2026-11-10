# ADR-0045: Scoped Guidance Refresh From Touched Paths

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0044; ADR-0014 supplement A

## Context

ADR-0044 injected project guidance for the workspace root only. In a real
repository the most important rules usually live in a subdirectory: `src/api/AGENTS.md`
often says more about a module than the root file does. An agent that reads
`src/api/handler.ts` while following only the root rules is missing the rules that
were written for exactly that file.

## Decision

Collect the paths a Run touches, and refresh guidance from them at each model
request boundary.

### Touched paths (`domain/context/touched-paths.ts`)

An explicit map from tool name to the parameters that carry a path. Not a generic
"scan any string that looks like a path":

- a false positive would load guidance from an unrelated directory;
- a false negative would silently miss a rule.

Both failure modes are worse than the small maintenance cost of a literal table, and
an unknown tool contributes nothing because it cannot be assumed to touch the
filesystem. `rename_path` contributes both sides; directory tools are marked so the
loader includes the directory's own `AGENTS.md`.

### Refresh (`RuntimeCoordinator.#refreshGuidance`)

Called at the top of each loop iteration, before the request is sent, with the
accumulated touched paths. The resolver reloads guidance for every touched path,
deduplicates by file path, and returns the union.

Two properties matter:

- **The guidance turn is replaced, not appended.** Otherwise the history would grow
  by one copy per round. A test asserts exactly one `[project-guidance]` turn in the
  second request.
- **A resolver failure keeps the existing text.** Guidance is helpful context;
  dropping it mid-Run would be a silent behaviour change. No new source means no
  rewrite, so a Run that touches nothing new does not churn the history.

### Relative paths

Tool arguments are usually workspace-relative (`src/api/handler.ts`) while discovery
needs an absolute path. The loader now resolves through the workspace policy first,
which also rejects an escape before any listing. **This was a real bug**: the first
version passed the relative path straight to discovery, which requires an absolute
path, so every refresh silently did nothing. The scope test failed with the nested
rule absent and found it.

## Verification

- 1081 tests pass across 232 suites; the vitest suite runs 12 render tests.
- Six unit cases cover path extraction: file tools, directory tools, rename's two
  sides, an unknown tool, a non-string path, and dedup on merge.
- One wire test drives a real tool round trip: the first request carries only the
  root rule, the second carries the nested `api rule: use UTC`, `system` stays
  undefined, and exactly one guidance turn is present.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No removal.** If the path set shrinks (a file deleted, a directory left behind),
  guidance already injected is not withdrawn. Guidance is arguably still relevant to
  the history, but that is a decision not yet made explicitly.
- **No standalone `AGENTS.md` read tool.** A user cannot ask the agent to load a
  guide directly; only touching a path triggers a refresh.
- **No budget enforcement.** Guidance accumulates toward context without C04 checks,
  because compaction is still not wired.
- **No Session toggle**, and no source list in the TUI, both of which the confirmed
  design calls for.
- Ordering is "root first, then deeper" because blocks are merged in discovery order;
  a strict root-to-leaf sort of the merged set is not asserted.

## Consequences

- Module-level rules now reach the model as soon as it looks at the module.
- The relative-path bug is fixed and covered, which also means any future caller
  passing a relative path behaves.
- The remaining gaps are removal, budget and UI, not scope.

## Reassessment Conditions

Decide guidance removal only with an explicit policy, not by inference. Enforce the
budget together with compaction.
