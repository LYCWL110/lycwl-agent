# ADR-0006: Typed Per-Tool Environment Configuration

Date: 2026-10-30.
Status: accepted by the user's explicit confirmation of the C09 proposal.
Documentation only. No feature coding, setup, real vault access, or process
execution is authorized.

## Problem And Constraints

ADR-0003 already permits persistent user-managed non-Shell variable exceptions.
The supplied C09 example only describes Shell overrides, so it cannot replace
that policy. Decide how a specific tool configuration represents ordinary
values, inherited values, secrets, exceptions, revisions, and revocation.

Keep TUI-owned authorization, final environment filtering, per-instance LSP
startup approval, Shell one-shot exceptions, and the owned-Provider-key
prohibition. Configuration is not execution authorization or an OS sandbox.

## Reference Evidence

The preceding discussion rechecked the following specific paths:

- OpenCode `7ab721a97f383b89a8d901c87866b1565c1cfd9c`,
  `packages/schema/src/config/lsp.ts:14`: optional per-server string env map.
- Miyu `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`,
  `crates/miyu-engine/src/tools/mcp/connection.rs:83`: applies configured
  per-server variables to the child command.
- Local Claude Code 2.1.88 snapshot,
  `src/services/lsp/LSPClient.ts:100`: merges subprocessEnv() with options.env.
  Its source provenance remains unverified as recorded in AGENTS.md.

These observations support per-tool configuration, not the claim that the
references implement our typed secret references or final filtering policy.
Reviewing Miyu's MCP path does not approve MCP implementation. No source was
copied, and no new complete book reading was performed. The book is not claimed
to prescribe these configuration fields.

## Candidates And Tradeoffs

1. Plain string env map. Lowest complexity, but mixes ordinary values and
   secrets and risks plaintext persistence contrary to the accepted boundary.
2. Typed variable sources plus explicit filtered-name exceptions. Slightly more
   validation/TUI work, but explicit provenance, bounded standing authority, and
   separation of secret storage from configuration.
3. Shared reusable environment profiles. Convenient for many tools but adds
   sharing, authority propagation, and revocation complexity without a V1 need.

Recommend candidate 2. The user answered "可以" to that recommendation and its
six accompanying rules. Candidate 2 is accepted.

## Decision

The maintained behavioral contract is
[V1_CONTRACTS.md C09](../architecture/V1_CONTRACTS.md#c09-environment-configuration-confirmed-direction).
It defines per-concrete-process configuration with typed set sources,
unset, exact allowFiltered names, and revisions; dedicated tool-secret
references; case-insensitive collision/override rules; save/revocation behavior;
and explicit V1 exclusions.

Do not share model/search authentication references with tool environment
configuration. Reference purpose is validated at the credential boundary, not
only by naming convention. Owned Provider key values remain prohibited under
any variable name regardless of source.

Field names are design labels, not an approved executable JSON Schema. Exact
encoding, identity binding, event payloads, and transaction/failure cases remain
contract deliverables, not a reason to reopen the selected source/storage model.

## Impact

TUI edits typed sources without persisting secrets in JSONC. Configuration and
credential adapters preserve purpose/revision metadata; ProcessSupervisor and
permission policy consume the final checked environment and approved snapshot.
No universal environment-profile service or plugin framework is introduced.

Per-tool exceptions reduce repeated variable prompts but grant standing
authority to that configuration. Startup approval remains separate. Changes
affect future launches and unused grants; already running processes keep values
they received, and revocation cannot erase those values or their descendants.

## Acceptance And Remaining Work

During separately authorized implementation, use synthetic values to verify:
all three source kinds, reference-purpose rejection, no plaintext-secret
serialization, exact-name exception scope, final filtering, owned-key rejection,
Windows same-layer collisions and cross-layer overrides, config save/rollback,
revision changes, unused-grant invalidation, and unchanged running environments.
Test the unchanged Shell/LSP boundaries and excluded expression/.env mechanisms.

Finalize schemas, case normalization, set/unset conflict handling, non-secret
snapshot fingerprints, reference lifecycle, and crash/failure tables before
affected coding. G01-G10 remain OPEN; none of these behavioral tests has run.

## Reassessment

Revisit if a supported tool requires source remapping/expressions, shared
profiles become a demonstrated need, credential-purpose isolation cannot be
enforced, process identity changes cannot be bound safely, or approved future
multi-Agent/remote execution changes scope. Obtain user confirmation before
changing standing authority or disclosure rules.
