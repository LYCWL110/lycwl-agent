# ADR-0057: Workspace Document Skills Reached By The Model

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0027 (skills domain), ADR-0044 (guidance injection)

## Context

ADR-0027 implemented Skill catalog parsing, limits and rendering. Nothing called it,
so `.agents/skills/` had no effect on the agent. That is the same shape of gap as
guidance and compaction: correct code, no consumer.

## Decision

Add filesystem discovery and inject the catalog as untrusted material.

### Discovery (`adapters/windows/skill-discovery.ts`)

Only `.agents/skills/<skillId>/SKILL.md` inside the workspace. No home, ancestor,
global-install or network discovery, and no directory is created.

- **Off by default.** `--skills` enables it, matching the confirmed per-Session
  switch. Enabling grants no read permission: the catalog is metadata, and a body is
  read through ordinary `read_file`.
- **Sorted by id before the limit is applied**, so a filesystem's incidental order
  cannot decide which skills are visible.
- **An invalid directory name is reported, not skipped.** Silently ignoring it would
  hide a skill the author believes exists.
- **A directory without `SKILL.md` is skipped**: that is not an error, just an
  incomplete directory.

### Injection

The catalog is appended to the guidance block as one sourced context, guidance first
so a skill description cannot appear to override project rules. The rendered block
labels itself `trust=untrusted project material`, and a test asserts the request's
`system` field stays undefined.

### Launch summary

The selection reports `skills: N catalogued (~M tokens)`, `none`, `disabled` or the
failure code, because "did my skills load" is not something a user should infer.

## Verification

- 1203 tests pass across 264 suites; the vitest suite runs 12 render tests.
- Nine discovery tests cover: disabled returns without touching the filesystem,
  catalog construction with id ordering, a missing directory, an empty directory, a
  directory without `SKILL.md`, an invalid id, `allowed-tools` rejection, a
  name/directory mismatch, and the per-file size bound.
- Two wire tests drive the real selection path: with `--skills` the request carries
  the catalog and `system` stays undefined; without it the catalog is absent.
- `pnpm run verify` exits 0.

## What This Still Does Not Do

- **No TUI toggle or catalog view.** The switch is a launch flag, not a Session
  control, and there is no screen listing the skills or showing their versions.
- **No body loading.** The catalog is metadata only. A user cannot ask the agent to
  "use skill X" through a dedicated action; the model can read the body with
  `read_file` if it decides to, which is the selected design but untested against a
  real model.
- **No refresh.** The catalog is built once at launch; editing a `SKILL.md` during a
  Session has no effect until restart.
- **The catalog counts toward context** without C04 budgeting of the block itself,
  beyond the 4096-token catalog bound.
- No streaming, and one of four protocols remains.

## Consequences

- A workspace can define documentation Skills and the model sees their descriptions.
- The untrusted boundary holds: a skill cannot promote itself to a system rule.
- The remaining gaps are UI, refresh and body-loading, not the trust model.

## Reassessment Conditions

Add a Session toggle and catalog view together with the TUI work. Add safe-boundary
refresh only with the same mechanism guidance needs.
