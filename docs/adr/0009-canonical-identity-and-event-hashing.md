# ADR-0009: Canonical Identity, JSON Normalization, And Event Hashing

Date: 2026-10-30.
Status: accepted by the user's explicit confirmation of the Stage 0
Runtime/tool draft's identity/hash profile. Design/documentation only; no
implementation, dependency installation, Git operation, or runtime test is
authorized.

## Problem

The Runtime draft proposes UUIDv7 identifiers, RFC 8785 (JCS) canonical JSON,
and SHA-256 digests as the identity/hash baseline. These underpin event-chain
integrity, approval/preview/precondition digests, and future multi-Agent
identity boundaries. The baseline was verified against the three reference
projects before confirmation instead of being adopted as an inherited default.

## Reference Evidence

Verified on 2026-10-30 against the fixed baselines:

- OpenCode, locked commit `7ab721a97f383b89a8d901c87866b1565c1cfd9c`:
  `packages/schema/src/event.ts` defines durable events with `id`, an
  aggregate-scoped `seq`, `version`, and `created`;
  `packages/core/src/event/sql.ts` persists events to SQLite with a unique
  `(aggregate_id, seq)` index; `packages/core/src/session/projector.ts`
  derives projections from those events. No JCS canonicalization or event hash
  chain was observed in these inspected paths.
- Miyu Agent, locked commit
  `5df19e2f19a2f6db2f1b2ed2fbe5c2186b04c5c5`:
  `crates/miyu-core/src/state/conversation_db/types.rs` uses string IDs, turn
  sequences, and serde-tagged journal events;
  `crates/miyu-core/src/state/conversation_db/turns/journal.rs` appends turn
  journal events into SQLite. No JCS or event hash chain was observed.
- Claude Code 2.1.88 local snapshot (`D:\claude-code-source-main`):
  `src/bootstrap/state.ts` creates session IDs with `randomUUID()`;
  `src/types/logs.ts` chains transcript entries with `parentUuid`; hash
  utilities such as `src/utils/hash.ts` use SHA-256. The snapshot uses UUID
  plus linked JSONL but no evidence of RFC 8785 JCS was found in the inspected
  paths.

These observations cover specific inspected paths, not full audits. No
reference project is claimed to implement this exact combined profile.

## Alternatives And Tradeoffs

1. Follow the references only: plain IDs with sequence or parent linking.
   Lowest complexity, but digests and chain verification depend on
   serialization order and give no canonical cross-implementation hash.
2. Adopt UUIDv7 plus JCS plus SHA-256 with a linked event chain. Adds
   canonicalization rules (numeric precision, Unicode, duplicate-key
   rejection) and hashing cost, but yields deterministic digests for
   invocation/preview/precondition identity and tamper-detecting event
   history.
3. Invent custom canonicalization. Avoids the JCS profile but creates a
   nonstandard format that must be maintained forever.

## Decision

Adopt candidate 2:

- Application identifiers follow the draft's ASCII 1-128 character rules;
  UUIDv7 is the confirmed default generation profile.
- Canonical JSON for hashing is RFC 8785 (JCS). Parsers must reject duplicate
  object keys before canonicalization.
- `sha256(value)` is lowercase-hex SHA-256 over the JCS form of the stated
  schema/versioned value. Every digest record states the schema/version.
- Event envelopes use the `previousEventId`/`previousHash`/`hash` chain
  defined in the draft. The chain detects corruption, not malicious same-user
  disk modification.

## Impact

The event writer, checkpoint recovery, approval/preview/precondition digests,
attachment hashes, and future multi-Agent identity boundaries share this
profile. JSON number and Unicode handling must follow JCS exactly. Selecting
and verifying a JCS implementation is a separate Stage 0 dependency decision
that still requires its own authorization before installation.

## Reassessment

Reopen if a verified JCS implementation cannot be adopted under the approved
dependency policy, if Provider or protocol constraints conflict with storing
JCS-normalized Harness events (external Provider payloads themselves are not
canonicalized), or if multi-Agent identity requirements change. Weakening
duplicate-key rejection or digest coverage requires a new user decision.

## Execution Status

Markdown documentation only. No feature code, dependencies, Git operations,
credentials, paid requests, or runtime tests.
