# lycwl

Windows and Linux terminal coding agent. Requires Node.js 24 and the project dependencies.

Each launch starts a new conversation in a separate terminal screen. Exit with
Esc to restore the original terminal content. Messages within that launch retain
their context. Old records stay on disk and are only loaded with
`lycwl --resume <session-id>` or the explicit `/session resume <session-id>` command;
the ID is printed at startup and shown in `/session`.

Scroll over the conversation with the mouse wheel or
PgUp/PgDn; Ctrl+Home/Ctrl+End jump to the beginning/latest messages.
Type `/` for commands with English descriptions, Tab to complete and Enter
to select. Esc dismisses command suggestions before exiting the application.
Commands appear in a compact highlighted menu above the input without moving it.
The dot scanner shows Thinking during model requests and Working during tool
work, and stops while waiting or after the Run ends.

Start from the repository in PowerShell:

```powershell
.\lycwl.cmd
```

On Linux, use Node.js 24 and register `lycwl` once from this checkout:

```sh
pnpm install
pnpm build
npm link --offline --ignore-scripts --no-audit --no-fund
```

Then run `lycwl` from the project you want to work on. Put options after the
command, using the same syntax as Windows:

```sh
lycwl
lycwl --write
lycwl --shell
lycwl --skills
lycwl --resume <session-id>
lycwl --setup
lycwl --help
lycwl --version
```

The npm global executable directory (`$(npm prefix -g)/bin`) must be on `PATH`.
If registration fails with `EACCES` because the global prefix is a system directory,
use a user-owned prefix instead of running the registration with `sudo`:

```sh
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
npm link --offline --ignore-scripts --no-audit --no-fund
```

Add the `export PATH` line to your shell startup file (for example `~/.bashrc`
for interactive Bash) so it also applies in new terminals.
The registration links to this checkout; run `pnpm build` after source changes
and keep the checkout in place. No shell alias or separate Linux command is needed.

Linux uses Bash for approved commands. Configuration and credentials live under
`$XDG_CONFIG_HOME/lycwl-agent` (default `~/.config/lycwl-agent`); session data
uses `$XDG_STATE_HOME/lycwl-agent` (default `~/.local/state/lycwl-agent`). Image
paste uses `wl-paste` on Wayland or `xclip` on X11 when available.
Oversized clipboard images are refused on Linux; automatic image resizing remains
Windows-only. No clipboard program is installed automatically.

Build or run the Linux-specific tests from this checkout:

```sh
pnpm build
lycwl --help
pnpm test:linux
pnpm test
```

`pnpm test` selects shared tests plus independent Linux suites on Linux, and keeps
the original Windows suites on Windows. Windows test files, commands and import
paths are unchanged; Windows-specific legacy suites are excluded on Linux.

Register the existing package entry point once to use `lycwl` from any project:

```powershell
npm.cmd link --offline --ignore-scripts --no-audit --no-fund
```

If PowerShell blocks the generated `lycwl.ps1` under its execution policy,
rename only that generated shim to `lycwl.ps1.disabled` in the npm global prefix
(`npm.cmd prefix -g`). PowerShell can then resolve `lycwl.cmd` without changing
the execution policy. Repeating `npm.cmd link` may regenerate the `.ps1` shim.

```powershell
lycwl
lycwl --help
lycwl --write
lycwl --shell
lycwl --resume <session-id>
```

The current directory is the session workspace. `--write` enables file changes
with approval; `--shell` also enables shell commands with approval.
Provider settings are configured in the TUI.
The model browser reads context capacity from the model list, then queries the
selected model's details when capacity is missing. If neither supplies a valid
length, the default is **272,000 tokens** (272k, not 272 × 1024). A valid manual
`Context tokens` value remains an explicit override. Set `Output tokens` to an
accepted output limit in `/config`.

Context displays distinguish upstream declarations, manual overrides and the
unverified default. Upstream fields such as `context_length`, `context_window`,
`max_context_length`, `limits.context` and input-token limits are recognized;
output-token limits are not used as context capacity. Switching connections or
models invalidates automatic metadata. Missing metadata in an old configuration
also uses the 272k default at runtime. The default is a local budget, not proof
that an upstream model accepts that many tokens; choose a smaller manual value
when the provider documents a smaller window.

Messages submitted during model activity appear immediately as `queued`.
They become `ready` when added to task context, `sending` with the next main
request, and `sent` after its complete response. Interrupted sends remain
`unknown`; unsent messages on ended Runs remain `retained` for review.
Queue rejections show a reason and retain the draft.

Tool calls occupy a compact status row. Click the row or press Ctrl+T to expand
recorded arguments and output, then use the wheel or PgUp/PgDn to scroll.
Click again or press Ctrl+T to collapse. Expansion never approves or reruns a tool;
approval previews stay separate and complete.

On Windows, Shell commands use PowerShell 5.1 with `-NoProfile -NonInteractive`.
Linux uses `/bin/bash --noprofile --norc -c` with a filtered environment and
case-sensitive POSIX paths. Linux command process groups have an IPC-disconnect
watchdog so ordinary descendants are terminated if the Harness crashes. This is
not a sandbox: a program that creates an independent session can escape cleanup.
Relative working directories resolve against the selected workspace. Cancelling
a Run requests termination of its supervised commands and background tasks;
effects already performed are not rolled back.

Search applies workspace `.gitignore` and `.ignore` rules, with `.ignore` taking
precedence. Sensitive paths are skipped before content is read and reported as
partial scope. Use `read_file` for a one-shot approval to disclose a sensitive
file. Changed file preconditions require a fresh decision; a denied or failed
mutation stops the remaining calls in that model response.

Open `/config`, enter the connection URL and API key, then select the Model row
and press Enter to load the model list. Select a model with the arrow keys and
press Enter to save. An endpoint without a model-list API still requires a
manual model ID (`a` in the model column).

Available commands:

| Command | Action |
| --- | --- |
| `/model` | Open model selection directly, including reasoning effort |
| `/config` | Edit the Provider connection, protocol, URL and key |
| `/session` | Show the current ID, create a session or resume by ID |
| `/new` | Start a fresh conversation; keep the previous records |
| `/session resume <id>` | Restore the selected recorded conversation |
| `/help` | Show the command list |
| `/cancel` | Cancel the current Run |
| `/key` | Correct only the current connection key during an authentication wait |
| `/resume` | Explicitly continue the same Run after correcting its key |
| `/quit` | Close the session and exit |

Model/configuration and session changes require an idle or ended Run.
Finish or cancel the current Run first. Help, cancellation and exit remain
available while running. Model selection applies to the next Run; opening
configuration does not clear the current conversation. Session switching waits
for current resource cleanup. Missing session IDs remain on the current screen.
Session history is selected by ID; a searchable history catalog is not provided.
Saving a corrected key does not resume a waiting Run. `/key` keeps its current
Provider, endpoint, protocol, model and credential reference; `/config` still
cannot change routes while a Run waits. Sensitive history may require separate
request-specific redisclosure consent after account/key changes.

Session history is checked for sequence/hash-chain corruption before restoration
and append. A live Session holds exclusive ownership (Win32 handle on Windows,
`flock` on Linux); another launch
cannot resume that ID until cleanup finishes. These checks detect corruption,
not deliberate same-user history rewriting.

Build the application JavaScript without downloading dependencies:

```powershell
npm.cmd run build
npm.cmd run start:built -- --help
```

`dist/` is a local build, not a reviewed portable release. Full raw
evidence/report persistence, complete Provider/tool coverage and release
acceptance remain work in progress. Tests and ADRs are tracked. Linux verification
does not replace running the unchanged Windows suite on a real Windows host.

OpenAI Chat, Responses and Anthropic Messages expose a Reasoning selector in the form and a
Reasoning column to the right of Model in the model browser. Use Right or Tab
to focus it, Up/Down to select a level, then Enter to save. The `r` shortcut
also cycles the current model's available levels. The form opens this same
selector. The default sends no explicit reasoning setting.

The catalog first reads explicit upstream effort declarations from `/v1/models`.
If levels are missing, it looks up `/v1/models/{model}` for the selected model.
It recognizes `effort.supported_levels/default_level` (DeepSeek-compatible),
`capabilities.effort` (Anthropic), OpenRouter's `reasoning.supported_efforts`,
and the optional gateway extension `supported_reasoning_efforts`.
When provided, the upstream default is shown without forcing an explicit value.
Details are cached only in the open configuration browser, with up to 64 entries.

These declarations filter choices; they are not compatibility test results.
Standard OpenAI model records do not expose these levels.
Only explicit upstream declarations supply selectable effort levels. Reference
catalog values and manual overrides are hidden, including the former `Manual...`
action and `m` shortcut. Missing, malformed or conflicting metadata leaves only
`default`, which omits the parameter and makes no compatibility claim.
A saved effort that is no longer selectable requires a new choice before saving.
Ctrl+R refreshes the catalog; changing
the connection, key or protocol discards old declarations and cached details.
Available explicit values include `max`; model declarations and protocol limits
still apply. Chat sends `reasoning_effort`, Responses sends `reasoning.effort`,
and Anthropic sends `output_config.effort`. Selecting effort does not implicitly
enable Anthropic thinking or set a thinking token budget.
Discovery uses read-only model metadata requests, without generation probes.
Upstream declarations are labelled as declarations, not live verification.
Thinking toggles and token-budget
presets from OpenCode are not imported as effort levels.
