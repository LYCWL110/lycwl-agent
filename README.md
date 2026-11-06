# lycwl

Windows terminal coding agent. Requires Node.js 24 and the project dependencies.

Interactive startup uses a separate terminal screen. Exit with Esc to restore
the original terminal content. Messages in the same session retain their
conversation context. Scroll over the conversation with the mouse wheel or
PgUp/PgDn; Ctrl+Home/Ctrl+End jump to the beginning/latest messages.
Type `/` for commands with English descriptions, Tab to complete and Enter
to select. Esc dismisses command suggestions before exiting the application.

Start from the repository in PowerShell:

```powershell
.\lycwl.cmd
```

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
```

The current directory is the session workspace. `--write` enables file changes
with approval; `--shell` also enables shell commands with approval.
Provider settings are configured in the TUI.

Open `/config`, enter the connection URL and API key, then select the Model row
and press Enter to load the model list. Select a model with the arrow keys and
press Enter to save. An endpoint without a model-list API still requires a
manual model ID (`a` in the model column).

OpenAI Chat and Responses expose a Reasoning selector in the form; the model
browser also cycles it with `r`. The default sends no explicit reasoning setting.
Other levels depend on the selected model and endpoint; this build does not
map reasoning effort to Anthropic thinking settings.
