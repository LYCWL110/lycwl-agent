# ADR-0042: Write Tools Behind An Explicit Opt-In

- Status: Superseded by ADR-0090 (2026-11-24)
- Date: 2026-11-05
- Related: ADR-0041; C02; S02

## Context

An agent that can only read is not useful for coding. The write implementations
existed — `create_file`, `edit_file`, `apply_patch` — but the composition root passed
`enableWrites: false`, so the model could neither see nor call them.

## Decision

Expose write tools when the caller opts in, and only then.

### Opt-in, not default

`lycwl --write` enables them. Without the flag the composition root stays
read-only, and the catalog filter already keeps unregistered tools out of the
request, so the model is not told a capability exists that it cannot use.

Making writes the default would have been easier and wrong: a session started to
answer a question should not be able to modify the workspace because the caller
forgot a flag.

### Approval still gates every write

`create_file`, `edit_file` and `apply_patch` declare `requiresApproval: true`, so
they suspend and reach the TUI through the coordinator's existing suspend path. The
inline `ApprovalGate` — which denies, because no interactive channel is attached to
it — is not involved. That separation is why enabling writes does not require
weakening the read-side gate.

The launch summary now states which mode is active, because "can this session
write" is exactly the kind of thing a user must not have to infer.

## Verification

- 1064 tests pass across 225 suites; the vitest suite runs 12 render tests.
- The wire test asserts the **request body** in both modes:
  - writes off: `glob, grep, list_dir, read_file, todo` — and explicitly that
    `create_file` is absent;
  - writes on: the same five plus `apply_patch, create_file, edit_file`.
- `pnpm run verify` exits 0.

The first attempt asserted `tools.length === TOOL_CATALOG.length` and failed with
`actual: 5, expected: 8`. That failure was correct and useful: it proved the filter
respects the flag, which a count-against-catalog assertion had been hiding.

## What This Still Is Not

- **No test exercises a real write end to end.** The wire tests prove the model is
  *offered* the tools; they do not drive an approved `create_file` through the
  coordinator to disk. The executor and approval paths have separate coverage, but
  the full chain is unverified.
- **Denied writes are silent to the user beyond the tool result.** There is no
  distinct denied-write panel.
- Shell, background, LSP and web tools remain disabled; shell in particular needs
  G02 evidence before it should be exposed.
- No streaming, and three of four protocols remain unimplemented.

## Consequences

- `lycwl --write` is a coding agent in the narrow sense: it can read, search, plan
  and modify files, with each modification approved.
- The default remains read-only, so the safe mode is the one you get by not asking.
- The gap between "tool offered" and "tool executed successfully end to end" is
  recorded rather than assumed.

## Reassessment Conditions

Add an end-to-end write test through the coordinator before claiming write support
works. Enable shell only with G02 evidence.
