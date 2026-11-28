# ADR-0107: Browser Interface As a Second View of the Same Session

- Status: Accepted (2026-11-28), amended by ADR-0108
- Related: ADR-0090 (default permissions), ADR-0038 (unencrypted credentials),
  ADR-0108 (terminal default and web subcommand)

## Context

The terminal UI is the only front end: it owns the composer, approvals,
questions and session panels, and it is the only way to drive a Run. Users asked
for a browser front end with the same authority so the agent can be driven from a
tab, including from a machine that cannot run an interactive terminal.

The presentation state already exists in a serializable form. `TuiController.view()`
returns a `TuiViewState` built from authoritative Runtime events, and the browser
can render a superset of it without reaching into the Coordinator.

## Decision

`lycwl --web` starts a loopback HTTP server whose only dependency is the existing
`TuiController` command surface, one controller per Session:

- The server binds `127.0.0.1` only. `Host` must name a loopback host with the
  server port and cross-origin state-changing requests are rejected, which blocks
  DNS-rebinding; there is no separate token, because reaching the port is already
  the same trust boundary as opening a terminal.
- The browser is a pure view. It reads full `WebState` snapshots over
  Server-Sent Events and sends the same intents the TUI composer sends; it never
  executes a tool, decides a permission or writes a session file itself.
- The transport is a full snapshot, not an incremental protocol. At this state
  size the bandwidth is irrelevant and applying a snapshot cannot drift out of
  sync after a dropped connection.
- Bootstrap owns composition. `src/bootstrap/web-launch.ts` assembles each
  Session exactly like the TUI does, and `src/web` may not import `bootstrap`,
  so the browser cannot acquire configuration or credential authority of its own.
- The client is plain HTML/CSS/ES modules under `src/web/static`, copied into
  `dist/web/static` by `tools/copy-web-assets.mjs` during `pnpm run build`.
  No bundler, no CDN, no new dependency.

Session switching opens the new runtime before closing the old one, so a failed
switch leaves the current conversation usable and answers `409` while it runs.

## Consequences

The web server has exactly the authority of the terminal it replaces: approvals
shown in the browser allow writes and commands in the same workspace. That makes
the browser a trusted front end, not a reduced mode; `--read-only` remains the
way to shrink authority.

Two front ends can be pointed at the same workspace from different processes
without coordination, the same as two terminals. One process serves one live
Session at a time; other Session rows open in the same process, replacing it.

The configuration flow stays terminal-only in this decision: the browser cannot
open the setup form, so an unconfigured launch serves the documented demo runtime
with a visible warning. ADR-0108 later adds the browser setup form and restores
the terminal as the default presentation.

## Reassessment Conditions

Revisit if the browser needs to run on a non-loopback interface (which would
require authentication), if a second workspace viewer justifies an event
protocol, or if the configuration flow becomes renderable outside Ink.
