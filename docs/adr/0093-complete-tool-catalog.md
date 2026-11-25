# ADR-0093: Catalog Every Built-In Tool, Filter At The Composition Root

- Status: Accepted (2026-11-25)
- Related: ADR-0041 (catalog and wire), ADR-0090 (default full permissions)

## Decision

`TOOL_CATALOG` describes every built-in tool this build implements, including
`delete_path`, `rename_path`, the three LSP tools, and the two web tools. It no
longer tries to mirror the default read-only tool set.

Availability stays authoritative in the composition root. `availableTools` filters
the catalog through `getDefinition`, so a catalog entry alone never reaches the
provider. The flags remain separate:

- `delete_path` and `rename_path` follow `enableWrites` and still require approval.
- LSP tools follow `enableLsp`; a server must also be started and approved, and the
  tools fail with `lsp_not_started` otherwise.
- Web tools follow `enableWeb`; every request still requires approval, and search
  still refuses without a configured backend.

`SelectRuntimeOptions` now forwards `enableLsp` and `enableWeb` to the workspace
tool composition. Without that pass-through the catalog entries were unreachable
through the real selection path, and the flags had no caller.

## Consequences

The catalog and the executor definitions can be reviewed as one contract instead
of the catalog re-encoding which flags a session happened to use. Tests that
assert the advertised list still drive real selection options, so a tool that is
not wired stays invisible on the wire.

LSP remains off by default because enabling the flag alone is not enough to make
it useful: there is no LSP start tool yet. Web tools are now on by default under
ADR-0094, which also composes the search credential; the catalog entries remain
schemas, not availability promises for a build that passes `enableWeb: false`.

## Reassessment Conditions

Revisit when an LSP start tool is composed. The search credential path is now
composed under ADR-0094, which makes web tools available by default.
