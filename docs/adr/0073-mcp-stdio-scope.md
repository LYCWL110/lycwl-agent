# ADR-0073: MCP stdio servers admitted to v1, narrowly

- Status: Accepted (2026-11-08)
- Supersedes: the MCP exclusion in the former AGENTS.md scope line
- Related: ADR-0002 (search authentication), ADR-0003/0006 (C09 environment), ADR-0004/0007 (C10 owned keys), ADR-0022 (design closure)

## Context

The original v1 scope excluded MCP: "MCP, remote execution, cross-session long-term memory,
third-party tool plugins and macOS support are excluded from v1. Do not build their
implementation infrastructure speculatively."

The user asked for MCP support. MCP is a real capability gap: without it the Harness cannot
reach an ecosystem of tools that already exist. It is also, uniquely among the excluded items,
a *tool source* rather than a coordination or distribution mechanism — it does not require the
multi-Agent scheduler, remote execution or a plugin loader that the exclusion was protecting
against.

Two reference implementations were reviewed before proposing scope:

- **OpenCode** (`anomalyco/opencode` at `7ab721a97f383b89a8d901c87866b1565c1cfd9c`),
  `packages/core/src/mcp/stdio.ts`: spawns a child process, passes the server's declared
  environment with `extendEnv: true` so the host environment is merged by the spawner, uses a
  2 s close grace and a 2 s force-kill deadline, a 16 MiB frame cap, and keeps the last 1 KB of
  stderr. It also supports HTTP/SSE and OAuth.
- **Miyu** (`SHORiN-KiWATA/miyu-agent` at `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`),
  `crates/miyu-engine/src/tools/mcp/`: a connection pool with separate protocol, scope and
  runtime layers.

OpenCode's `extendEnv: true` conflicts with this project's C09 rule that the **final**
environment passed to a child is the filter output. Adopting it verbatim would silently
reintroduce filtered credentials. The design below keeps OpenCode's transport shape and
discards its environment merge.

## Decision

MCP is admitted to v1 with the narrowest scope that is useful:

1. **stdio only.** No HTTP, SSE or OAuth. An HTTP MCP server would need the pinned-address
   connector, address-set approval and redirect refusal that WebFetch already implements;
   reusing that is a separate change with its own review. stdio needs none of it.
2. **User configuration only.** Servers are declared in `mcp.servers` in the user settings
   document under `%LOCALAPPDATA%`. Never discovered on disk, never added from a project file,
   never fetched. A project file is untrusted input and must not be able to start a process.
3. **Approved once per launch, before spawn.** The declaration is shown as an approval prompt
   containing the exact executable, the exact argument vector, the working directory, the
   environment entries, and the two facts that matter: `sandbox=none` and
   `permissions=current Windows user`. Anything other than an explicit `y` denies. Approval is
   not remembered across launches: a server that starts silently on every boot is a persistent
   privilege, and v1 grants none.
4. **C09 final filter, applied last.** The host environment and the declared entries are merged
   and then filtered by `filterChildEnvironment`. A declaration naming a filtered variable
   removes it rather than restoring it. The filter runs after the merge, so there is no
   ordering that reintroduces a credential.
5. **Namespaced tools, per-call approval.** Every tool is exposed as
   `mcp__<serverId>__<toolName>`. The prefix makes collision with a built-in impossible by
   construction, which matters because a shadowed `shell` would be a silent privilege change.
   Each call still requires its own one-shot approval and is classified `external_request`:
   the Harness cannot know what an MCP tool does, so it must not accept a server's own claim
   that it is read-only.
6. **Process lifetime follows the pipe.** The server is spawned with piped stdio, so it dies
   with the Harness on every path that was measured (see the limitation below). Running it under
   the G02 Job Object remains the intended end state, but it is not what makes the process safe
   today, and claiming otherwise would misdescribe the implementation.

## Deliberate limitations, recorded rather than hidden

- **The implementation spawns with `child_process`, not the Job Object supervisor, and
  measurement shows this does not leak on any path tested.** This section previously said a hard
  crash leaks; that was an assumption, and it was wrong. What was measured, with a control
  proving the liveness probe itself is sound:

  | Scenario | Outcome |
  | --- | --- |
  | Normal `close()` on a real `@modelcontextprotocol/server-filesystem` | process count 3 to 1, pid gone |
  | Harness `taskkill /F` | server dies |
  | Harness `process.exit(1)` with no cleanup | server dies |
  | Server that swallows EPIPE | server dies |
  | Server that never reads stdin | server dies |
  | Real MCP handshake, then Harness crash, judged by a heartbeat file | heartbeat stops |

  The mechanism is the pipe, not the Job Object: when the parent exits, the child's stdin and
  stdout handles close, so a server reading stdin sees EOF and one writing stdout sees EPIPE.
  Node's own runtime exits when its handles are gone.

  A Job Object would still matter for the cases a pipe does not cover: a server that detaches and
  redirects its own stdio, one that forks an independent tree, or a `TerminateProcess` landing in
  the milliseconds before the child notices the closed handle. None of these has been observed.
  Closing that gap requires adding `WriteFile` to the Koffi bindings, exposing the stdin write
  handle the supervisor currently closes on creation, and revalidating the 200 G02 race cases
  against a bidirectional model. That work is not justified by an unobserved failure, and doing it
  while G02 is still open would add risk to the gate rather than reduce it.
- **No server-initiated requests.** A server that sends a request to the client is answered with
  a JSON-RPC "method not found" error. Implementing sampling or roots would give a third-party
  process a way to drive the Harness.
- **No tool result size accounting beyond the frame cap.** A 16 MiB frame is the transport
  bound. The ordinary tool-output and attachment policy applies to what reaches the model, and
  the C10 owned-key guard runs on it like any other tool output.
- **MCP is untrusted input in both directions.** Tool descriptions and results are third-party
  text. A description is not an instruction, and a result grants no authority.

## Consequences

- The AGENTS.md scope line is amended; the exclusion now names remote execution, cross-session
  long-term memory, third-party tool plugins and macOS, and a new line records the MCP admission
  with its limits.
- `domain/mcp/mcp-server.ts` owns declaration validation, tool naming and tool-list validation.
- `adapters/windows/mcp-connection.ts` owns the JSON-RPC stdio transport and handshake.
- `adapters/tools/mcp-tools.ts` exposes servers as an ordinary `ToolExecutor`.
- `bootstrap/mcp-startup.ts` owns approval, environment filtering and startup ordering.
- `bootstrap/terminal-approval.ts` provides the pre-TUI approval channel, denial by default.
- A declared server that fails to start does not take the Session down; the failure is reported
  as a launch warning and the Session runs without that server's tools.
- No permission, credential or output rule is weakened. Every existing boundary applies
  unchanged to MCP tools.

## Reassessment conditions

Reopen this decision if: an orphaned server process is actually observed; a server is found that
detaches or redirects its own stdio; a concrete need for HTTP/SSE MCP appears (that requires the
WebFetch connector review); or a server's tool schema cannot be represented faithfully enough for
the model to call it.
