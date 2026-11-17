# ADR-0086: Add Linux without replacing the Windows implementation

- Status: Accepted (2026-11-16)
- Related: ADR-0035 (architecture checks), ADR-0058 (Shell), ADR-0073 (MCP)

## Decision

The same package selects its platform at bootstrap. Windows retains PowerShell
5.1, the Win32 Job Object supervisor and the original synchronous background
registry. Linux never evaluates those native process bindings. Its supervisor
runs Bash in a separate process group with an IPC-connected watchdog. Cancellation,
timeout, output limits and Harness disconnect terminate that group; pipe closure
is awaited before reporting completion. A detached descendant in its own session
is outside this boundary, so this is not equivalent to an OS sandbox.

Linux shares existing Node filesystem implementations through explicit Linux
exports. POSIX workspaces use case-sensitive paths and ignore rules, preserve file
mode on replacement and reject final symlink targets. Windows drive and UNC rules
remain separate, including forward-slash UNC roots. Shared domain functions accept
explicit platform choices; they do not inspect the host environment.

Configuration and plaintext credentials use `$XDG_CONFIG_HOME/lycwl-agent`, defaulting
to `~/.config/lycwl-agent`. Session state and search accounting use
`$XDG_STATE_HOME/lycwl-agent`, defaulting to `~/.local/state/lycwl-agent`. Relative XDG
values are ignored. Linux locks use `flock` on an open descriptor, released by the
kernel when its owner dies. New private configuration directories use mode 0700;
credential files use 0600. This does not protect secrets from the same user.

The Linux clipboard reads bounded PNG output from `wl-paste` (Wayland) or `xclip`
(X11). No display or missing tooling reports unavailable. Large images are refused;
Windows image normalization is unchanged.

## Tests and compatibility

Existing Windows test files and import paths are unchanged. Linux behavior is
covered by separate `linux-*.test.ts` files. The test runner selects applicable
shared suites and Linux suites on Linux, and the original suites on Windows.
`pnpm test:linux` runs only the Linux-specific files and requires Linux.

The retained Linux suite exercises path and permission boundaries, file mutations,
guidance/skills, environment filtering, lock exclusion and crash release, Shell and
background cancellation, guarded output limits, watchdog cleanup, configuration,
session restoration, snapshots and clipboard branches. Shared tests exercise model
protocols, MCP and LSP. A Linux run cannot certify Windows native behavior; the
unchanged Windows tests must still be run on Windows before a dual-platform release.
