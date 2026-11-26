# ADR-0105: Make The Advertised Tool Contract Match Execution

- Status: Accepted (2026-11-26)
- Related: ADR-0074 (discovery), ADR-0082 (no output schema), ADR-0102 (report facts)

## Decision

Fix the gaps where the model could select a tool but the runtime could not
complete the call, or where success changed more than the approval described:

- `discover_tools` now returns the matched names as `discoveredTools`. The
  coordinator carries those names on the Run and adds their schemas to the next
  provider request through `ProviderRequest.tools`. A discovery result is only
  useful if the next request declares the tool.
- `apply_patch` carries the preflight BOM flag and restores it after encoding.
  Editing line 2 of a UTF-8-BOM file no longer removes the BOM while reporting
  success.
- The LSP capability flag is passed to the catalog-construction tool executor,
  not only to the execution instance, so enabling LSP makes the three LSP tools
  visible.
- `edit_file` exposes `insertedLineEnding` (`lf` or `crlf`) in the public schema.
  The executor already required it for mixed-ending files.
- `read_file` documents and schemas its real bounds: default 200 lines, maximum
  2,000; continuing uses `startLine`.
- `shell.verification: true` is recorded in task reports as `basis:
  caller_declared`. It means the caller marked the command as verification, not
  that the project declares or passed that acceptance command.

Tool descriptions remain the place for selection guidance; schemas carry hard
parameters; executors own the promised effect. Output schema is still omitted
(ADR-0082).

## Consequences

The discovered MCP schema is added only after the discovery round, so the first
request remains compact. A provider that rejects undeclared functions now gets a
valid declaration on the next round.

The context-budget fixed estimate does not yet include dynamically discovered
schemas; a future measurement should decide whether to re-estimate after
discovery.

## Reassessment Conditions

Revisit if discovery needs to be replayed after resume, if BOM/encoding handling
expands to other mutation tools, or if read_file paging needs a cursor rather than
`startLine`.
