# ADR-0026: Child Process Environment Was Never Actually Filtered

- Status: Confirmed fix of a defect against already-confirmed policy
- Date: 2026-11-05
- Related: AGENTS.md Child-Process Environment Filter Baseline; V1_CONTRACTS.md C09; ADR-0003/ADR-0006

## Context

The confirmed policy says the shared Child-Process Environment Filter Baseline is
applied to **the final environment of every Harness-launched child process**, and
that a later overlay must never restore a filtered entry. The code appeared to
implement this: `domain/process/shell.ts` owns the fixed name list plus
`INPUT_` counterparts, `filterChildEnvironment` merges and filters, and both
`shell-tool.ts` and `background-tools.ts` call it before spawning.

None of it took effect. Both `CreateProcessW` call sites in
`process-supervisor.ts` passed `null` for `lpEnvironment`, and in Win32 that
means **inherit the parent environment**. The computed filter result was
discarded at the last step. Every shell command and every background task
therefore received the full parent environment, including `ANTHROPIC_API_KEY`,
`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN` and the rest of the list the project
claims to remove.

This is the worst kind of gap: a documented security guarantee that tests and
code review could not see, because the filtering logic was correct and the
preview honestly reported "N name(s) removed" while nothing was removed.

## Decision

Pass the filtered environment to the process and make inheriting impossible.

- `SpawnRequest.environment` and `start({ environment })` are **required**. There
  is no default, so omitting it is a type error rather than a silent full inherit.
- `buildEnvironmentBlock` in `koffi-bindings.ts` encodes the map as Windows
  requires: case-insensitively sorted `NAME=VALUE` strings, each NUL-terminated,
  with a final extra NUL. An empty environment still gets the terminator.
- Both call sites pass `CREATE_UNICODE_ENVIRONMENT` because the block is UTF-16LE.
  Without that flag Windows would interpret the block as ANSI and corrupt values.
- `shell-tool` passes `filter.environment` through to `runToCompletion`, and
  `background-registry` passes its `environment` argument through to `start`.
  The parameter was previously named `_environment`, which is exactly the signal
  that it was ignored.

## Verified Behaviour

Tests now prove the property instead of assuming it. Using `cmd` `set`/`echo`:

- a fixed filtered name (`ANTHROPIC_API_KEY`) is absent from the child, and its
  value never appears in captured output;
- a non-filtered variable survives intact;
- a catalog-derived name passed via `providerCredentialNames` is removed;
- an explicit one-shot grant still restores exactly that name.

`buildEnvironmentBlock` has unit coverage for the double NUL, empty input and
case-insensitive ordering. The 100-race and 100-completion G02 runs still pass,
so supervision, kill-on-close and timeout behaviour are unchanged.

## Consequences

- Child processes are now isolated from parent credentials by name, which is what
  the baseline always claimed. This is still name-based filtering, not OS
  isolation and not a secret detector; a secret under an unlisted name is not
  removed.
- Two test files had been passing only because they inherited the parent
  environment while asserting behaviour unrelated to it. `process-supervisor.test.ts`
  and `background-timeout.test.ts` now supply an explicit environment. Their
  previous form could not have detected this defect.
- Behaviour change worth naming: a caller that supplies an empty or partial
  environment now gets exactly that environment. `ping`, `cmd` builtins and
  anything else needing `PATH`/`SystemRoot` will fail. That is correct
  fail-closed behaviour, but it means the tool layer must always pass the merged
  result rather than a hand-built map.

## Known Limitation

Node's `process.env` does not expose Windows' hidden per-drive current-directory
variables (`=C:=C:\...`). A child launched from an explicit block therefore has
no per-drive current directory until it sets one, so a relative path on a drive
other than the working directory's may not resolve the way it did when the child
inherited everything. The working directory passed to `CreateProcessW` itself is
unaffected. This should be revisited if it causes real breakage; it does not
justify reverting to inheritance.

## Reassessment Conditions

Revisit the per-drive limitation only, and only with evidence of a concrete
failure. Do not treat "it worked when we inherited everything" as a reason to
remove the explicit environment: that inheritance is the defect this ADR fixes.
