# ADR-0108: Terminal Default and Explicit Web Subcommand

- Status: Accepted (2026-11-28)
- Related: ADR-0107 (browser interface), ADR-0106 (read-only MCP boundary)

## Context

The first web build made the browser the default presentation and kept the
terminal behind `--cli`. The repository's primary front end is still the
terminal: approvals, configuration and session recovery were designed there
first, and existing commands and documentation assume `lycwl` opens a terminal.
Scripts and habits written before the web build also expect that.

The browser is a second view of the same Runtime, so the launch choice belongs to
the entry point, not to the Session composition. The web build already contains
every commit on `main`; merging it is a fast-forward, and `main` stays the
authoritative harness tree.

## Decision

- `lycwl` starts the interactive terminal UI.
- `lycwl web` starts the loopback browser UI. `--web` remains an alias.
- `--web-port` applies to `lycwl web`; the default remains an ephemeral port on
  `127.0.0.1`.
- `--cli` is accepted for compatibility but no longer selects anything.
- The browser presents the Provider setup form when the Session is unconfigured.
  The form asks for protocol, endpoint, model and API key, saves through the same
  config store and vault as the terminal, and reloads the current Session. This
  amends the terminal-only configuration consequence in ADR-0107.
- Battle-tested harness files are taken from `main`; the web branch only adds
  `src/web`, `src/bootstrap/web-launch.ts` and its tests. Conflicts, if a future
  merge produces them, are resolved in favor of `main` for shared harness code.

## Consequences

The browser is opt-in, so installing or upgrading cannot silently move an
existing workflow from the terminal into a server process. The web server still
binds loopback only and grants the same authority as the terminal that launched
it; `--read-only` remains the way to shrink that authority.

A first web launch without a Provider no longer prints a dead-end instruction to
run the Ink setup. It starts the server, marks the Session as unconfigured and
opens the setup form; the composer stays disabled until a model is configured.

## Reassessment Conditions

Revisit if the browser becomes the primary interface for new users, or if the
web setup grows approvals that the terminal setup does not have.
