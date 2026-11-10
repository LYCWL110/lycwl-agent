# ADR-0041: Model-Facing Tool Catalog And What It Must Not Claim

- Status: Implemented and verified locally; no real vendor request made
- Date: 2026-11-05
- Related: ADR-0040; C03; RUNTIME_TOOL_CONTRACTS

## Context

`assembleRuntime` was passing an empty tool list, so the model could hold a
conversation but could not read a file, search, or plan. `ToolDefinition` had no
`description` field either, so there was nowhere for a description to live.

## Decision

Add one catalog that owns every tool's description and JSON Schema, and send only
the entries the composition root actually exposes.

### Catalog (`domain/tool-catalog/tool-catalog.ts`)

A `ToolDefinition` describes identity and side effects for the Runtime. A catalog
entry describes the tool *to the model*. These are different contracts, and keeping
both in one file is what stops the advertised contract from drifting away from the
implemented one.

`availableTools(isAvailable)` filters by what is registered. The reason is
concrete: a schema for a tool the build does not wire makes the model call it and
receive `tool_unavailable_in_build`, which reads like a fault rather than a
boundary.

### A claim I had to retract

The first catalog listed six tools, including `ask_user`. The wire test failed:

```
actual: 4, expected: 6
```

Two of the six were not real:

- **`todo`** had an implementation at `adapters/tools/todo-tool.ts` but was never
  registered in the composition root, so the model could have called it and been
  told it does not exist.
- **`ask_user`** has **no adapter at all** in the real path. `executeToolCall`
  special-cases the tool name, but nothing registers a definition for it, so
  `getDefinition` returns null before that special case is reached.

The second one is the more interesting failure. A catalog can describe a tool that
is implemented, unwired, or entirely absent, and only the last two are lies. The
test caught it because it asserted the *count that reached the wire* rather than the
count in the catalog.

Both were fixed rather than removed from the test: `todo` is now registered
(a planning tool with no side effects), and `ask_user` was removed from the catalog
because wiring it is a design change, not a catalog entry.

## Verification

- 1063 tests pass across 225 suites; the vitest suite runs 12 render tests.
- The catalog test asserts that every entry has a real description, a closed schema
  with `additionalProperties: false`, and that every `required` key is declared.
- The wire test drives the real selection path against a local HTTPS server and
  asserts the request body carries exactly the catalog's tools with
  `input_schema` objects.
- `pnpm run verify` exits 0.

No real vendor request was made.

## What This Still Is Not

- **`ask_user` cannot be called by the model.** The coordinator handles the tool
  name, but with no registered definition the model never sees it. Interactive
  questions therefore only work in the demo runtime.
- **Write, delete, rename, shell, background, LSP and web tools are absent** from
  the catalog because the composition root does not enable them. That is accuracy,
  not a feature decision.
- **Tool results are not yet delivered back with descriptions of the workspace** —
  the model sees raw executor output.
- No streaming, and three of four protocols remain unimplemented.

## Consequences

- The model can now actually read files, list directories, search and plan.
- The advertised tool set is derived from what is registered, so enabling a flag
  later does not require editing the catalog by hand for the four core tools.
- The gap between "implemented" and "reachable" is now visible in a test rather
  than discovered at runtime.

## Reassessment Conditions

Wire `ask_user` only together with a definition registration path, not by
special-casing it further. Add tools to the catalog only in the same change that
registers them.
