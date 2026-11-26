# ADR-0084: Comparison against the Claude Code snapshot, and what was acted on

- Status: Accepted (2026-11-08); the memory exclusion is superseded by ADR-0104.
- Related: ADR-0013 (prompt provenance), ADR-0044 (AGENTS.md as untrusted), ADR-0083 (Harness rules), ADR-0104 (explicit memory)

## Context

The local snapshot at `D:\claude-code-source-main` (package 2.1.88) was reviewed
module by module against this project, at the user's request, to find both missing
capabilities and risks.

Scale, for orientation rather than as a target:

| | Claude Code | This project |
| --- | --- | --- |
| Source files | ~2000 | 186 |
| Tools | 42 | 15 |
| TUI components | 389 | 21 |
| Service modules | 130 | 10 |

## What was a defect, and was fixed

**Provenance marker forgery.** The model is told that a turn beginning with
`[project-guidance]` is project material. A repository file containing that literal
rendered a second marker and a forged trust line, with no way to tell which was
real. Measured before the fix and verified after. See the commit and
`domain/context/provenance-marker.ts`.

This is the only finding that was a defect rather than a scope difference.

## What was missing, and why it stays missing

| Capability | Reference | Why not here |
| --- | --- | --- |
| Shell command classifier (137 KB) | `bashSecurity.ts`, `powershellSecurity.ts` | It exists to decide whether a command may run *without* approval, which is the auto-allow mode. Every shell command here requires one-shot approval, so the question it answers does not arise. The residual risk is different and is recorded below. |
| Subagents (6 task tools, 228 KB agent tool) | `AgentTool`, `TaskCreate/Get/List/Update/Output/Stop` | Multi-agent is excluded from v1. |
| Plan mode | `EnterPlanMode`, `ExitPlanMode` | No separate planning phase; the Todo tool covers task tracking. |
| Persistent PTY / REPL | `REPLTool`, `persistent-pty` | Excluded from v1. |
| Session memory | `SessionMemory`, `extractMemories`, `memdir` | Cross-session memory is excluded from v1. |
| MCP resources | `ListMcpResources`, `ReadMcpResource` | A real gap, not a scope decision. Tools only for now. |
| MCP OAuth | `McpAuthTool`, `services/oauth` | API-key-only scope. |
| Scheduled tasks, worktrees, output styles, vim mode, prompt suggestions, tips, auto-dream | — | Not adopted; each is a product decision this project has not made. |
| OAuth, team memory sync, remote managed settings, bridge, upstream proxy, analytics, voice | — | Out of scope. |

## Risks recorded rather than fixed

1. **No shell risk annotation.** The approval preview shows the exact command, but
   nothing marks the destructive part of a compound command such as
   `Get-Content a.txt; Remove-Item -Recurse C:\important`. The user must read the
   whole line. This is a real residual risk of the approval model, distinct from the
   classifier problem: the classifier decides *whether to ask*, and this would help
   the user *answer*.
2. **Compaction can lose detail.** Claude Code's prompt tells the model to write down
   anything it will need, because old tool results may be cleared. This project
   compacts but has no such instruction. Adding it is a candidate, not done here.
3. **No user-defined permission rules**, therefore no risk of a shadowed or bypassed
   rule. The smaller scope removes a class of bug rather than introducing one.

## Consequences

- One security fix: provenance markers are escaped in all three untrusted renderers.
- The rest of the comparison is recorded so the same ground is not re-covered, and
  so a future decision to adopt something starts from what was already considered.

## Reassessment conditions

Reopen if shell command risk annotation is wanted, if compaction is observed losing
detail the model needed, or if MCP resources are adopted.
