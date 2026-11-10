# ADR-0063: `/init` Project Draft And The MCP Exclusion

- Status: `/init` implemented; MCP explicitly out of v1
- Date: 2026-11-08
- Related: ADR-0014 (guidance), ADR-0057 (skills)

## Context

The user asked for three things: `/init`, MCP support, and Skills. Checking each
against the code and the confirmed rules produced three different answers, and it is
worth recording why rather than treating them as one request.

## What Was Already Done: Skills

`domain/context/skills.ts` and `adapters/windows/skill-discovery.ts` existed and were
wired through `--skills`. Nothing needed building. The remaining gap is a TUI toggle
and a catalog view, which is UI work rather than capability.

## What Was Refused: MCP

`AGENTS.md` states:

> MCP, remote execution, cross-session long-term memory, third-party tool plugins, and
> macOS support are excluded from v1. Do not build their implementation
> infrastructure speculatively.

and separately:

> Future multi-Agent/MCP/remote/sandbox versions require separate decisions, not more
> v1 infrastructure.

MCP is not a missing feature to be added; it is an excluded capability whose
introduction would require a new architectural decision. The reason is concrete: an
MCP server is a third-party process with its own environment, credentials and trust
relationship, and the project has not decided how such a server is authorised, how its
environment is filtered, or how its tools enter the registry. Adding the code first
would settle those questions by accident.

This ADR records the refusal so a later reader does not treat it as an oversight.

## What Was Built: `/init`

`/init` drafts an `AGENTS.md` from what the project declares.

### Detection (`domain/context/project-init.ts`)

Pure, over a listing the caller supplies. It reads the package name and scripts from a
manifest's **contents** (a filename cannot carry them), and infers the language from
declared configuration **and** observed extensions, because a project without a
manifest still has source files.

Nothing is invented: a project with no test script gets no test command, and an empty
section is omitted rather than rendered as "none".

### Scan (`adapters/windows/project-init.ts`)

Bounded to three levels and skips generated directories (`node_modules`, `target`,
`dist`, `coverage`, `.git`, and similar). Skipping matters: without it, extension
counts would be dominated by vendored code.

Only `package.json` is read, so the scan cannot pull arbitrary project text into
memory.

### Safety

An existing `AGENTS.md` is reported and **never overwritten**. A new one is written
through the ordinary path, so the same approval and path policy apply as any other
file creation.

## Verification

- 1569 tests pass across 312 suites; the vitest suite runs 15 render tests.
- 11 tests cover: manifest name and scripts, Rust detection, no-manifest projects, a
  malformed manifest, extension frequency ordering, notable config files, omitting
  empty sections, including detected stack and commands, refusing to overwrite,
  skipping generated directories, and drafting without a manifest.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **`/init` writes without an approval prompt.** It runs from the TUI, which has no
  channel back to the coordinator's approval path, so the write bypasses the one-shot
  approval every other mutation requires. That is a real inconsistency and should be
  fixed before this is relied on.
- **No Skills TUI toggle or catalog view**, so a skill's existence is still invisible
  in the interface.
- **No MCP**, by decision.
- `/init` reads only `package.json`; a Rust or Python project's declared scripts are
  not extracted even when the manifest is present.

## Consequences

- A new project can get a starting `AGENTS.md` without hand-writing one.
- The MCP exclusion is now stated in a place a future reader will find, rather than
  living only in AGENTS.md.
- The `/init` approval gap is recorded as a defect rather than left implicit.

## Reassessment Conditions

Fix the `/init` approval gap before treating the command as safe. Reopen MCP only as a
new architectural decision covering authorisation, environment filtering and registry
integration.
