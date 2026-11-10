# ADR-0003: Configured Non-Shell Environment Exceptions

Date: 2026-10-30.
Status: accepted by explicit user confirmation of the narrowed R02 proposal.
Documentation only; no implementation or process execution authorized.

Follow-up: [ADR-0005](0005-runtime-contracts.md) and V1_CONTRACTS.md C09 adopt
compatible revision/rollback/precondition details. The supplied C09 Shell-only
example is not adopted as a replacement for this confirmed per-non-Shell-tool
exception policy; its concrete configuration schema remains pending.

Subsequent confirmation: [ADR-0006](0006-non-shell-environment-configuration.md)
selects typed per-tool sources, dedicated secret references, exact exception
names, Windows collision/override rules, and revision/revocation behavior.
Executable schemas and tests remain pending, not those design choices.

## Problem

All Harness child processes share final-environment filtering. Some non-Shell
tools may need variables removed by default. Decide whether exceptions require
repeated approval, are prohibited, or can persist in user-controlled configuration.
Do not silently equate process startup approval with credential authorization.

## Evidence And Constraints

OpenCode baseline: `7ab721a97f383b89a8d901c87866b1565c1cfd9c`.
The following files were checked by read-only GitHub API access:

- `packages/schema/src/config/lsp.ts:14` permits configured LSP `env` entries.
- `packages/core/src/mcp/stdio.ts:26` documents server-configured environment;
  its spawn at line 84 passes that environment with `extendEnv: true`.
- `packages/util/src/cross-spawn-spawner.ts:132` merges the host environment
  first and configured entries afterward when extendEnv is enabled.

These inspected paths demonstrate configuration and inheritance, not a
universal secret-filter or per-variable approval guarantee. This project adopts
the configuration workflow with its own safety boundaries, not identical
OpenCode behavior. MCP remains excluded from V1.

Existing project constraints include user-level configuration, no repository
configuration, final shared filtering, LSP process-instance approval, one-shot
Shell variable grants, and no child-process injection of Harness-owned Provider
keys. No book passage is claimed to specify this exception policy.

## Candidates And Tradeoffs

1. Prohibit non-Shell exceptions in V1. Lowest implementation complexity but
   prevents use of some otherwise valid tools.
2. Require per-instance, per-variable one-shot authorization. Narrower grants
   and explicit disclosure, but adds prompts whenever a process restarts.
3. Persist user-configured per-tool exceptions. Better compatibility and fewer
   repeated prompts, but increases standing authority and requires trusted
   configuration ownership, change handling, and visible startup previews.

## Recommendation And Confirmation

The initial recommendation was candidate 2. The user chose the OpenCode route.
After source verification, the assistant proposed candidate 3 with the existing
project safety boundaries preserved; the user explicitly answered "可以".
Candidate 3 in that narrowed form is accepted.

## Decision

Non-Shell tools may receive explicitly configured variable exceptions scoped
to that tool. The user manages them through the TUI; they persist in that tool's
configuration and do not require per-invocation variable approval. Project
files, model-generated content, and ordinary tool output cannot create or
authorize exceptions.

Inherited and tool-specific environment entries are merged first. One shared
final policy applies the default filter and applicable authorized exceptions;
no subsequent overlay or implicit inheritance may bypass that check. Undeclared
filtered variables remain removed. A tool's exception is not a global exception.

LSP process-instance startup approval remains mandatory, including on restart.
Show variable names with secret values hidden. Persistent environment settings
do not authorize process execution. Existing Shell invocation-specific variable
approval is unchanged; these standing exceptions do not apply to Shell or to
background Shell commands.

Harness-owned Provider keys remain prohibited under any variable name, even
when an exception is configured. This decision does not authorize reading the
Harness credential vault to provision external tools. Secret values must not
be exposed through previews or diagnostic logging.

## Impact And Remaining Contracts

Configuration, permission policy, and ProcessSupervisor must share a trusted
view of the configured tool and its exceptions. Specify exact schemas,
secret-reference representation, configuration identity, change/removal
semantics, and approval precondition checks before implementation. Behavior-
changing alternatives require user review, not an undocumented implementation
default. Configuration persistence does not authorize plaintext secret storage.

Environment filtering is not an OS sandbox. An approved process may pass its
environment to descendants or access other resources available to the Windows
user. Revoking configuration does not retroactively erase values already
delivered to a process.

## Acceptance Requirements

During separately authorized implementation, test default removal, declared
per-tool exceptions, isolation between configurations, Windows case-insensitive
names, final-merge ordering, restart startup approval, unchanged Shell grants,
model/project inability to authorize exceptions, redacted previews, and rejection
of owned-key injection. G01-G10 remain open; no such test has run.

## Reassessment Conditions

Reopen if tools require broader inheritance, configuration changes cannot be
bound safely to execution, the owned-key prohibition cannot be enforced, or
multi-Agent/MCP/remote execution changes the trust boundaries. No silent
fallback to unfiltered parent inheritance is permitted.

## Execution Status

Markdown changes only. No feature code, dependencies, Git operations, credentials,
child processes for tools, or paid requests were introduced.
