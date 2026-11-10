# ADR-0076: Run the project's own formatter after a file change

- Status: Accepted (2026-11-08)
- Related: ADR-0003/0006 (C09 environment), ADR-0075 (snapshots), ADR-0020 (search scope)

## Context

A model that writes code rarely matches a project's formatting. OpenCode's
`formatter.ts` plus `formatter/builtins.ts` runs the project's formatter after an
edit: it selects by file extension, requires the project's own config, resolves the
executable from the project's dependencies, and runs it with the edit's cwd.

This Harness wrote files exactly as the model produced them, so every edit was a
potential unrelated-diff.

## Decision

After a **successful** filesystem mutation, the project's formatter runs over the
files that mutation wrote.

1. **The project's configuration decides, not this Harness.** Biome requires
   `biome.json`/`biome.jsonc`. Prettier requires one of its config files or a
   `prettier` dependency in `package.json`. A project with neither gets no formatting,
   and that is the normal case rather than a failure.
2. **The executable comes from the workspace's `node_modules`.** A globally installed
   formatter is deliberately not used: the project pinned a version, and running a
   different one would reformat to a style the project did not choose.
3. **Generated and vendored trees are excluded**: `node_modules`, `dist`, `build`,
   `out`, `coverage`, `.git`, `.next`, `.nuxt`, `target`, `vendor`. Formatting those
   rewrites files the project does not own.
4. **The environment goes through the C09 filter.** Applied twice: at the composition
   root and again inside the runner, so the adapter is safe to call with any
   environment rather than relying on its caller.
5. **A failure does not undo the write.** The file stays as the tool wrote it and a
   `tool_output_format_failed` event records the reason. Reverting would discard a
   successful edit because a formatter objected, which is worse than unformatted code.
   A timeout is reported distinctly from a formatter that ran and failed, because a
   timeout may have left the file half-written.
6. **Two events, not one**: `tool_output_formatted` with the formatter name, and
   `tool_output_format_failed` with the reason. "No formatter configured" emits
   neither, because it is the ordinary state of most projects.

## Consequences

- `domain/format/formatter.ts` owns selection rules; `ports/formatter.ts` owns the
  capability; `adapters/windows/formatter-runner.ts` implements discovery and
  execution.
- The coordinator runs formatting after the tool result is recorded, so a formatting
  problem never changes the tool's own outcome.
- The formatter list is two entries. Each needs an unambiguous config signal and a
  "format in place" command; a longer list would mean guessing about projects this
  Harness has not seen.

## Known limitations

- **Formatting is not separately approved.** It runs automatically after an approved
  mutation. The argument is that it is a consequence of the write the user already
  approved and only touches the same files, but it is still an external process the
  user did not name. A stricter build could make it an approval.
- **Only Biome and Prettier.** gofmt, rustfmt, clang-format and the rest are not
  included.
- **`package.json` is read at the workspace root only**, not through a monorepo
  workspace listing, so a formatter configured only in a nested package is missed.
- **The exclusion list is a fixed set**, not the project's ignore rules.

## Reassessment conditions

Reopen if a formatter runs on a project that did not ask for it, if the automatic
(unqueued) execution is judged too permissive, or if monorepo layouts need per-package
discovery.
