# ADR-0067: `/skills` Catalog Panel

- Status: Implemented and verified locally
- Date: 2026-11-08
- Related: ADR-0064, ADR-0066, P03

## Context

ADR-0066 recorded the last remaining usability gap in the Skill work: no TUI catalog
view. A user could run `/skill <id>` only if they already knew the id, and nothing in
the interface listed them. The catalog existed in context for the model and nowhere
for the user.

## Decision

Add `/skills`, a local panel listing the workspace catalog.

### Read-only, so available during a Run

Unlike `/config`, `/init` and `/skill`, this panel is **not** `idleOnly`. It lists
names and descriptions and loads no body, so blocking it while a Run is active would
be arbitrary. A user may reasonably want to see what a running Session could reach.

### A failure is not an empty list

`skillCatalogError` is carried separately from `skillCatalog`. A null catalog with a
reason is distinguishable from an empty catalog, which would claim the workspace has
no skills. That distinction is the same one the discovery layer already makes for
`not_found` versus an empty directory.

The controller loads the catalog **once per panel open**, so the view never performs
I/O and a rerender cannot trigger a filesystem scan.

### Rendering

Each entry shows its id in the primary colour and its description dimmed below it,
clipped to the panel width. An error renders as `unavailable: <code>`; an empty
catalog renders `no skills in .agents/skills`.

## Verification

- 1596 tests pass across 319 suites.
- Six tests cover: the command opening the panel, availability during a Run, rejection
  of trailing arguments, non-collision with `/skill`, and the view carrying either
  entries with no error or a reason with no entries.
- `pnpm run verify` typecheck passes; lint exits 0 at the existing baseline.

## What This Still Does Not Do

- **No selection or activation from the panel.** It lists; it does not let a user pick
  an entry to run. That would need an input mode the panel does not have.
- **No scrolling.** A catalog with many skills overflows the visible area; the panel
  has no offset state.
- **No version or hash display**, though the catalog records both.
- **No refresh while open**: the catalog is read when the panel opens.

## Consequences

- A user can discover what skills exist without reading the filesystem.
- The `idleOnly` distinction is now deliberate and documented per command rather than
  uniform.
- The gap between "lists" and "selectable" is stated rather than implied.

## Reassessment Conditions

Add selection together with an input mode for the panel. Add scrolling before claiming
the panel handles a large catalog.
