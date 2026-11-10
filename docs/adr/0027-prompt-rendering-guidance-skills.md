# ADR-0027: Prompt Rendering, Project Guidance And Skill Catalog

- Status: Confirmed implementation of already-confirmed design (P01/P03, ADR-0014 supplement A)
- Date: 2026-11-05
- Related: PROMPT_AND_USER_INPUT.md; V1_BEHAVIOR_CONTRACTS.md supplement A; V1_DESIGN_SUPPLEMENTS.md P01/P03; ADR-0013/ADR-0014/ADR-0016

## Context

Three confirmed designs had no code at all: deterministic prompt rendering (P01),
workspace-local `AGENTS.md` discovery (supplement A), and the minimal document
Skills catalog (P03 option B). Because context assembly is where trust is either
preserved or silently broken, leaving it unimplemented meant the project had no
enforceable answer to "can a repository file become a system rule?".

## Decision

Implement the three as pure domain policy plus one narrowly scoped filesystem
adapter, with no model wiring yet.

### Prompt rendering (P01)

`domain/context/prompt-render.ts` is a pure transform of explicit inputs. It does
not read the filesystem, environment, clock, network or randomness, so identical
input yields byte-identical output and a snapshot difference is meaningful.

- Provenance is structural: `harness_rule`, `user_input`, `project_material`,
  `runtime_fact`. Authority comes from the `source` field, never from text
  prefixes, fenced blocks or "please ignore injection" phrasing.
- Block order is fixed by source, then by id, so insertion order cannot change
  the render.
- `roleForBlock` gives `system` only to `harness_rule`. `validateRoleMapping`
  rejects a mapping that promotes project material, and reports (rather than
  silently accepts) a demoted harness rule.
- The manifest records bundle/renderer/adapter versions, per-block origin, byte
  size and a hash prefix. It is explicitly not a C03 final-request fingerprint.

### Project guidance discovery (supplement A)

`domain/context/project-guidance.ts` computes candidates; it takes directory
listings as input, so it cannot cause a read by accident.

- Only `AGENTS.md`, matched case-insensitively, from the workspace root down to
  the target's own directory, ancestors first.
- No repository-wide scan, no ancestors above the workspace, no fallback to
  `README.md` or `CLAUDE.md`.
- Two case-different matches in one directory is a hard failure, because picking
  one would be a silent trust decision.
- Per-file 64 KiB and total 256 KiB are checked before injection. Over-budget
  guidance is an explicit capacity error, never a silently truncated "complete
  rules" payload.

`adapters/windows/project-guidance-discovery.ts` performs the listing through the
existing reader, so the workspace path policy applies unchanged. It returns paths
only: contents still go through the ordinary governed read. A test asserts that an
injection payload in a guidance file never appears in the discovery result.

### Skills (P03 option B)

`domain/context/skills.ts` builds a catalog from `.agents/skills/<id>/SKILL.md`
sources supplied by the caller.

- Frontmatter accepts only `name` and `description`. It is not a YAML parser on
  purpose: `allowed-tools`, `hooks`, `model`, `fork`, `shell`, block scalars,
  anchors and duplicate keys are all rejected rather than parsed and then
  ignored, so no execution metadata can become authority by accident.
- `name` must equal the directory id; a mismatch would let one document claim
  another's catalog identity.
- Limits are enforced as refusals: 64 skills, 64 KiB per file, 4096 estimated
  catalog tokens, 512 code points per description.
- `renderSkillCatalog` marks the block `trust=untrusted project material` and
  quotes every description, so a hostile description is data rather than an
  instruction.
- No `load_skill` tool, no slash commands, no directory creation, no execution.

## What Is Still Not Delivered

- No wiring into `RuntimeCoordinator` or any Provider request. Rendering and
  discovery are policy and evidence, not an active prompt pipeline.
- No Session toggle for guidance or Skills, no TUI source list, no safe-boundary
  refresh, no compaction reinjection. Those remain supplement A / P03 work.
- No `.agents/skills` filesystem adapter. The catalog takes sources from its
  caller so the parsing and limits can be tested without one.
- Exact Provider wire fields and the four protocol render fixtures are still
  open. `roleForBlock` encodes the rule; it is not proof any adapter obeys it.

## Consequences

- The trust boundary is now executable and testable rather than prose.
- Adding these did not change any existing behaviour: nothing calls them yet, so
  the risk of this change is limited to the new modules and their tests.
- The strictness is deliberate. A future desire to accept richer frontmatter must
  come back as a decision, not as a parser relaxation.

## Reassessment Conditions

Revisit only with a concrete need: a real adapter that cannot express the four
sources structurally, or a documented case where a skill genuinely requires
execution metadata. Neither justifies promoting project material to a system
role, and neither is implied by adding model wiring later.
