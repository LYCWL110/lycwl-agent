# ADR-0106: Read-Only Launches Do Not Start MCP

- Status: Accepted (2026-11-27)
- Related: ADR-0090 (default permissions), ADR-0073 (MCP stdio scope)

## Decision

`--read-only` now covers MCP as well as writes, shell and web. When a launch is
read-only:

- declared MCP servers are not spawned, even if a launch approval channel exists;
- no MCP tools or discovery catalog are advertised;
- the launch warning says the servers were disabled rather than suggesting an
  approval failed.

Full-permission launches keep the existing MCP behavior: a declared server still
needs its separate launch approval, and every MCP tool call still needs its own
approval.

Default web search is unchanged. A full launch still uses the selected protocol's
native search or the Tavily tool as before; only `--read-only` disables web.

## Consequences

A user who explicitly selected read-only cannot start an unsandboxed third-party
server through a separate dialog. To use MCP, the user must choose the full mode.

The read-only flag is now an execution boundary for MCP, but not an OS sandbox:
full mode still runs MCP child processes with the current user's permissions.

## Reassessment Conditions

Revisit if MCP gains a separate per-server read-only mode, or if process isolation
can bound child network and filesystem access.
