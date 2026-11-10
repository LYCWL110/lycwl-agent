# ADR-0078: Verify a single-file edit and revert it when it does not compile

- Status: Accepted (2026-11-08)
- Related: ADR-0075 (snapshots), ADR-0076 (formatter), ADR-0077 (MCP schema/discovery)

## Context

SWE-agent (arXiv:2405.15793) measures its ACI design on SWE-bench Lite with GPT-4
Turbo. Removing the lint check after an edit drops resolution from 18.0% to 15.0%;
removing the dedicated `edit` interface drops it to 10.3%. A syntax error that
survives into the next turn costs a round trip at best and compounds at worst.

Measuring this Harness found the same gap. Writing `export const x = {{{;` returned
`{ ok: true }` and the broken content persisted. The snapshot and revert machinery
already existed and worked — a capture followed by `undoSessionChanges` restored the
original byte for byte — but nothing connected them to the edit path. `/undo` was a
manual command.

## Decision

After a successful single-file mutation, the file is compiled. A failure reverts the
edit and reports that the file is unchanged.

### The checker is tsc, not `node --check`

This was decided by measurement, and the measurement changed the design. The first
plan used `node --check`; testing showed it is unsuitable:

| Input | `node --check` | tsc |
| --- | --- | --- |
| `.mjs` with a syntax error | exit 1 | exit 2 |
| `.js` with a syntax error | **exit 0** | exit 2 |
| `.ts` with a syntax error | **exit 0** | exit 2 |
| valid `.ts` | **exit 1** | exit 0 |

`node --check` parses `.js` as CommonJS, so `export` is reported as "not a module"
and the real error is never reached. It does not parse TypeScript at all, not even
with `--experimental-strip-types`. Since this project's source is `.ts`, the check
would have passed almost everything and caught nothing.

In-process alternatives were rejected: `vm.Script` cannot parse ESM (0.3 ms,
0.27 MB), and `vm.SourceTextModule` handles ESM (0.6 ms, 0.57 MB) but needs an
experimental flag whose behavior is not guaranteed.

`tsc` runs through its JavaScript entry with `node`, never through the `.cmd` shim:
spawning a batch file on Windows needs a shell, and shell argument passing is
concatenation, which is the injection surface this project refuses elsewhere.

`--typeRoots` points at an empty temporary directory. Without it tsc loads the
project's `@types` and reports their errors, so every check would fail for a reason
unrelated to the edit.

### Scope is one file

Ten sequential checks cost about three seconds per edit; ten parallel ones peak near
350 MB. Neither is acceptable for a check that should be free, so a batch patch is
not checked. A single check costs about 300 ms and peaks at 35 MB in a child process
that is fully reclaimed on exit.

### A checker that cannot run is never a pass

Timeout, spawn failure and a missing file all produce `skipped` with a reason, and
`skipped` is recorded as `syntax_check_skipped`. Reporting a file as compiling when
nothing checked it would be a false verification, which is worse than no check.

### A failure reverts, and says so

The revert uses the snapshot taken before dispatch. When no snapshot exists the edit
stands and the failure is reported without a rollback claim — the event records
`reverted: false`, so the record does not overstate what happened.

The formatter runs after the check, not before: formatting a file that does not
compile would rewrite it on top of a failed edit.

## Consequences

- `domain/mutation/syntax-check.ts` owns parsing and rendering;
  `ports/syntax-checker.ts` owns the capability plus a `ChangeReverter` shape;
  `adapters/windows/syntax-checker.ts` runs tsc.
- New events: `syntax_check_failed` (with `line`, `message`, `reverted`) and
  `syntax_check_skipped` (with `reason`).
- A failed check turns the tool result into `failed` with the diagnostic, so the
  model sees "the edit was reverted; the file is unchanged" rather than a success.

## Known limitations

- **Types are checked too.** tsc reports type errors, not only syntax errors. An
  edit that is syntactically fine but type-wrong is reverted. That is defensible — a
  file that does not compile is a failed edit — but it is stricter than "syntax
  check" and a model that introduces a deliberate type error will be reverted.
- **No project `tsconfig.json` is used.** The flags are fixed so a check is
  predictable, which means a project with different `target`/`module` settings may
  see errors that its own build would not.
- **Batch patches are unchecked.** `apply_patch` touching several files skips the
  check entirely.
- **The check costs about 300 ms per edit**, which is noticeable for a model making
  many small edits.
- **Reverting discards the whole edit**, not just the broken part.

## Reassessment conditions

Reopen if the type-error strictness proves disruptive, if batch patches need
checking, or if a cheaper checker with equivalent coverage becomes available.
