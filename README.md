# lycwl

A local coding agent for Windows and Linux. It runs in a terminal and gives a
model permission-controlled tools: read and search files, edit them, run shell
commands, and talk to LSP and MCP servers.

Every write and every command is approved separately. Nothing is sandboxed: an
approved command runs with your full user permissions.

## Requirements

Node.js 24 and the project dependencies (`pnpm install`).

## Install

Windows, from the checkout:

```powershell
.\lycwl.cmd
```

Linux, once per checkout:

```sh
pnpm install
pnpm build
npm link --offline --ignore-scripts --no-audit --no-fund
```

`$(npm prefix -g)/bin` must be on `PATH`. If the global prefix is a system
directory and registration fails with `EACCES`, set a user-owned prefix
(`npm config set prefix "$HOME/.local"`) instead of using `sudo`.

## Use

Run `lycwl` inside the project you want to work on; that directory is the
workspace.

```
lycwl                  read-only
lycwl --write          allow file changes, each approved
lycwl --shell          allow shell and background commands (implies --write)
lycwl --skills         enable the .agents/skills catalog
lycwl --resume <id>    continue a recorded conversation
lycwl --setup          show configuration status and file locations
lycwl --help
```

Type `/` for commands (`/config`, `/model`, `/session`, `/new`, `/cancel`,
`/quit`). Each launch starts a new conversation; older ones stay on disk until
you resume them by ID.

## Configuration

Set the Provider connection, key and model in `/config`. The model browser reads
context capacity from the model list and falls back to **272,000 tokens** when
no valid declaration is available; a manual value overrides it. The default is a
local budget, not proof that the provider accepts that many tokens.

Linux keeps configuration under `$XDG_CONFIG_HOME/lycwl-agent` and session data
under `$XDG_STATE_HOME/lycwl-agent`. Windows uses `%LOCALAPPDATA%`. Credentials
are stored unencrypted (ADR-0038).

## Platform behaviour

| | Windows | Linux |
| --- | --- | --- |
| Shell | PowerShell 5.1, `-NoProfile -NonInteractive` | `/bin/bash --noprofile --norc -c` |
| Paths | case-insensitive | case-sensitive POSIX |
| Live session | Win32 handle | `flock` |

Linux commands run in their own process group with a parent-death watchdog, so
ordinary descendants die if the harness crashes. A program that starts an
independent session can still escape cleanup. Cancelling a Run terminates its
supervised commands and background tasks; effects already performed are not
rolled back.

## Development

```sh
pnpm build        # compile to dist/
pnpm verify       # lint, typecheck, tests, architecture, dist freshness
pnpm test         # shared suites, plus the platform's own
pnpm test:linux   # Linux-only suites
pnpm build:bun    # standalone binaries, requires Bun >= 1.4.4
```

`dist/` is a local build, not a reviewed release. Design decisions live in
`docs/adr`; the README is an introduction, not the reference.
