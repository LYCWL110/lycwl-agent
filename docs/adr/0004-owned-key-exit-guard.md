# ADR-0004: Exact Registered-Owned-Key Exit Blocking

Date: 2026-10-30.
Status: accepted by explicit user confirmation of R03. Design only; no
implementation, credential access, dependency installation, or testing authorized.

Follow-up: [ADR-0005](0005-runtime-contracts.md) and V1_CONTRACTS.md C10 refine
credential revisions, prefix buffering, protected channels, and blocked-output
behavior. Finite reviewed encoding representations may extend exact matching;
the detailed registry/restart/representation schema and tests remain open.
The source's eight-character minimum and Authorization-only authentication
exception are not adopted. Limitations below still apply outside registered
representations and verified exits.

Subsequent confirmation: [ADR-0007](0007-provider-key-length-policy.md) explicitly
rejects a universal minimum key length and keeps exact registered short-key
protection despite incidental matches. This refines admission/guard policy,
not the pending implementation tests or the trusted authentication boundary.

## Problem

Harness-owned Provider keys must not enter model context, tool results, logs,
or attachments. Credential access boundaries and structured field redaction
alone do not check whether a known key has reached an otherwise ordinary payload.
Select a concrete additional protection without adopting a general secret
scanner or silently modifying ordinary tool evidence.

## Evidence And Constraints

The preceding reference review inspected these paths at the reference identities
recorded in AGENTS.md:

- OpenCode `packages/http-recorder/src/redaction/redactor.ts:8` redacts selected
  authentication headers; `redaction/secrets.ts:36` checks recorded structures
  using secret patterns and known environment values.
- Miyu `crates/miyu-core/src/llm/request_log.rs:16` defaults request recording to
  disabled; its recording path at line 65 serializes the request body when enabled.
- Local Claude `src/bridge/debugUtils.ts:26` redacts selected debugging fields;
  `src/services/teamMemorySync/teamMemSecretGuard.ts:15` checks team-memory writes
  in that specific feature path. The local snapshot's official provenance has
  not been independently verified.

These observations support channel-specific safeguards, not a claim that any
reference universally blocks secret-bearing tool results. The chosen guard is
this project's design; no reference implementation is copied. No book passage
is claimed to prescribe exact-key matching.

Existing policy preserves ordinary tool output, applies explicit sensitive-read
approval, prohibits owned-key disclosure, and excludes a general secret scanner.
V1 has no OS sandbox.

## Candidates And Tradeoffs

1. Access boundaries and field/header redaction only. Simplest and avoids more
   in-memory key handling, but has no final exact-known-key check for free text.
2. Add exact registered-owned-key blocking at protected exits. Deterministic for
   the registered representations, avoids guessing arbitrary secret formats,
   but adds registry, streaming, serialization, and lifetime complexity.
3. Add general pattern/heuristic secret scanning. Broader potential detection,
   but false positives/negatives and policy complexity conflict with the
   confirmed ordinary-output approach; requires a separate decision.

## Recommendation And Confirmation

Recommend candidate 2. The user explicitly answered "可以" to the R03 proposal:
retain access boundaries and redaction, check exact registered-owned-key values
at protected exits, block matching payloads, preserve execution facts, and do
not introduce a general scanner. Candidate 2 is accepted.

## Decision

Keep trusted credential access confined to the appropriate authentication path.
Preserve structured credential-field and authentication-header redaction.
Add checks for exact registered Harness-owned Provider key values before
protected model-context, tool-result, log, and attachment payloads are released
or persisted. A match blocks the containing payload; do not silently rewrite
ordinary tool output or retain the matching raw attachment as a bypass.

Preserve actual execution facts separately. A command may have executed even
when its output is blocked. Blocking does not establish non-execution, erase
side effects, or authorize retry. Report output unavailability without echoing
the key or falsely claiming complete evidence was stored.

Legitimate authentication sent to the intended Provider is a distinct trusted
transport path, not model conversation content. This exception does not permit
credential bodies/headers to enter diagnostic copies or attachments, or keys
to enter arbitrary tool/network payloads.

Do not adopt generic token-prefix, entropy, or arbitrary-secret scanning under
this ADR. Do not change the existing policy for approved sensitive reads of
other credentials or ordinary output that contains no registered-owned-key match.

## Contract Closure And Module Impact

Before affected implementation, specify:

- Registry coverage and ownership, credential registration/removal, rotation,
  old-key lifetime, and recovery behavior. This ADR does not authorize enumerating
  unrelated vault entries or promise detection of keys outside registry coverage.
- Text/byte/serialization representations, checking order, and bounded streaming
  buffers that detect matches crossing transport chunks before those bytes are
  released or written. Checking after a raw temporary file is saved is insufficient.
- Guard failure behavior, blocked-output error/event schemas, and how projections
  separate execution certainty from unavailable evidence without automatic retry.
- Safe diagnostics and credential references that never repeat a blocked value,
  plus interaction with request construction, tool capture, logs, and attachments.

The Provider adapter, output/persistence paths, and credential boundary must
share these contracts; the TUI must not echo blocked secrets. Do not add an
unreviewed framework, blanket vault access, or general scanner to implement them.
Existing search-credential nondisclosure rules remain; this ADR does not claim
that an unspecified registry already covers every service secret.

## Limitations

Exact matching does not reliably cover encoded, split, transformed, or otherwise
unregistered representations. Registering known values is not universal secret
detection. Streaming safety and key lifecycle handling are requirements, not
verified properties.

Same-user child processes can bypass Harness-controlled exits and use other
Windows-user resources. This mechanism is not OS isolation, complete data-loss
prevention, secure memory erasure, or a guarantee of zero leakage.

## Acceptance Requirements

During separately authorized implementation, use synthetic credentials to test
each protected exit, every stream split position, serialization boundaries,
attachment capture before persistence, rotation/lifetime cases, and guard failure.
Verify that benign output is unchanged, structured logs redact credential
fields/headers, no blocked value appears in error paths, and output blocking
does not trigger duplicate execution or corrupt known tool outcomes.

Separately verify that intended-Provider authentication still functions without
placing the credential in model messages or diagnostics. Do not use real keys
or paid requests without separate authorization. G01-G10 remain open.

## Reassessment Conditions

Reopen if representation gaps do not meet the threat model, registry lifetime
cannot be managed safely, streaming/persistence cannot fail safely, or remote/
multi-Agent/sandbox requirements change the trust boundaries. Broader scanning
requires a new decision rather than silently extending this one.

## Execution Status

Markdown changes only. No Harness code, dependencies, Git operation, real
credential access, paid request, or runtime security test was performed.
