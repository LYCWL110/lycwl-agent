# ADR-0010: Adopt Stage 0 Pending-Review Recommendations

Date: 2026-10-30.
Status: accepted by the user's explicit "可以" confirming the unified review
of `docs/architecture/STAGE0_PENDING_REVIEW.md` as revised through two
external evaluations. Design/documentation only; no implementation, dependency
installation, Git operation, real credential access, paid request, or runtime
test is authorized.

## Problem

Stage 0 had twelve compiled recommendation areas awaiting unified user
review: disclosure consent scope, cancellation matrix, built-in tool fields,
compaction contracts, evidence/TaskReport, search ledger, C09 environment
schema, C10 credential schema, provider contracts, Windows integration, TUI
contracts, and engineering initialization. The compilation incorporated
reference comparisons and two external evaluations; a blanket confirmation
had to be recorded precisely, including what it does and does not authorize.

## Evidence And Review Path

- The compilation compares OpenCode (commit `7ab721a97f383b89a8d901c87866b1565c1cfd9c`),
  Miyu Agent (commit `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`), the local
  Claude Code 2.1.88 snapshot, and recorded book pages; evidence boundaries
  are stated per item ("not found in the checked versions and paths").
- First external evaluation: `chatgpt-export_架构合理性评估.md`
  (14,157 bytes, SHA-256 `02C72FC307F7352D8B5124C7A797D69CDE8DF6F71A9966CEE65A5E748849E17F`).
  Adopted: Job Object boundary declaration, four-step search dispatch order,
  protected environment variables (NODE_OPTIONS class), egress-class split
  for credentials, request-fingerprint consent binding, layered ordering.
- Second external evaluation: `chatgpt-export_审查未审查架构.md`
  (17,215 bytes, SHA-256 `9494D389C9EAB59015FE44283A7281CD5E305A399388ADB01A7480C6C95560DA`).
  Adopted: TaskReport four-dimension status model (replacing a flawed single
  priority chain), three-category environment variable policy with HMAC
  fingerprints, typed authentication egress versus unauthorized disclosure,
  CredFree API correction, G02 nested-Job/breakaway extension, not_sent_verified
  send-barrier gate, idempotent billing identifiers, ANSI/OSC sanitization,
  early minimal Windows validation, three-batch confirmation order.
- Fact check: Node 26.13.0 entered LTS on 2026-10-28 per the official
  nodejs.org release page (verified online 2026-10-30); 24.22.2 remains the
  conservative baseline candidate with 26.13.0 in compatibility comparison.
- The evaluations are recorded as review sources, not normative evidence.
  All their compatible modifications were adoptable without weakening any
  confirmed boundary (ADR-0004/0007/0008, C02/C07, the no-OS-sandbox rule).

## Decision

The user confirmed adoption of all twelve recommendation areas as revised in
`STAGE0_PENDING_REVIEW.md`:

1. Disclosure consent per affected logical model request, bound to
   `requestFingerprint` over the final sent content and key routing
   parameters; material changes invalidate consent.
2. Cancellation matrix as drafted, with conservative paid-search reservation
   retention; `not_sent_verified` requires persisted records plus
   send-barrier proof.
3. Built-in tool field inventory, including uniform path-safety
   classification for indirect reads, explicit argv versus shell-string
   modes, write-race detection, and delete/rename disabled until
   partial-completion semantics are specified.
4. Compaction request construction with structural versus semantic
   verification split and the sensitive-history disclosure boundary.
5. TaskReport four-dimension status model (`protocolRunState`,
   `verification`, `unknownOutcomes[]`, `claims[]`) and TR-01.
6. Search ledger state machine with the four-step durable dispatch order,
   crash-derivation of `possibly_sent`, manual-correction rules, and
   idempotent billing identifiers.
7. C09 three-category variable policy (ordinary / high-risk / forbidden),
   HMAC-based snapshot fingerprints, revision-bound approvals.
8. C10 representation-type-only registration, typed authentication egress
   table, app-controlled versus tool-process egress split.
9. Provider dual-freeze with unknown-capability/cost blocking.
10. Windows contracts including the Job Object non-sandbox declaration and
    extended G02 acceptance scope.
11. TUI contracts including ANSI/OSC sanitization and independent
    consent/resume/cancel semantics.
12. Engineering initialization direction: Node 24.22.2 conservative candidate
    with 26.13.0 in compatibility comparison; three-layer ordering with
    minimal Windows validation moved into the base security kernel.

This confirmation resolves the three remaining review questions in
`RUNTIME_TOOL_CONTRACT_DRAFT.md` (disclosure scope, cancellation matrix,
built-in tool shape) and records the draft as confirmed design; the file was
subsequently renamed `RUNTIME_TOOL_CONTRACTS.md` to reflect that status.

## Impact

Remaining Stage 0 documentation deliverables: per-tool JSON Schemas, formal
serialized schemas for the search ledger, environment configuration, and
credential registry, and the JCS implementation selection (which still
requires separate dependency authorization). Engineering gates G01-G10 remain
OPEN. Feature coding, dependency installation, Git initialization, real
credential access, and paid requests continue to require explicit separate
authorization; this ADR confirms design only.

## Reassessment

Reopen affected items if implementation or gate testing disproves a confirmed
mechanism (for example, breakaway handling or short-key usability), if vendor
or protocol constraints conflict with a schema, or if the user revises a
decision. Behavior changes return to the user; no silent weakening.

## Execution Status

Markdown documentation only. No feature code, dependencies, Git operations,
credentials, paid requests, or runtime tests.
