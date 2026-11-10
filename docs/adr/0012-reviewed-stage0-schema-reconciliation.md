# ADR-0012: Reviewed Stage 0 Schema Reconciliation

- Status: Confirmed
- Date: 2026-10-31
- Related: ADR-0011,
  [RUNTIME_TOOL_CONTRACTS.md](../architecture/RUNTIME_TOOL_CONTRACTS.md),
  [V1_CONTRACTS.md](../architecture/V1_CONTRACTS.md)

Later resolution: [ADR-0014](0014-remaining-behavior-contracts.md) adopts the
line-read, question, background, batch and layered-schema directions excluded
below. Limited delete/rename design is selected, while executable schemas,
G05/G06 and coding authority still gate real activation. This ADR's historical
exclusions do not undo that later confirmation or confirm the full Schema file.

## Context

The user supplied a reviewed revision of the Stage 0 JSON Schemas and directed
that its accepted corrections be applied and then confirmed into the project
architecture. The revision mixed three categories:

1. static repairs that remove contradictions with already confirmed behavior;
2. proposed behavioral changes that need a separate contract decision;
3. remaining review items and implementation gates.

Only category 1 is confirmed here. The full Schema file remains a pending
review artifact in `docs-check/`.

## Confirmed Corrections

### Cancelled Result With Process Facts

A `cancelled` tool result may carry process information when execution had
started. If it does, the result must carry `dispatchId` and `startedAtUtc`.
Only `denied` results are forbidden from carrying process information.

This preserves the distinction between a cancelled operation that never
started and one whose process was started before cancellation.

### Grep Result Bound

The `grep` result `matches` array is capped at 1000 items, matching the
confirmed maximum for `maxMatches`. Runtime must still validate
`totalMatches >= len(matches)` and must not treat the cap as proof of complete
search evidence.

### WebFetch Redirect Shape

`web_fetch.redirectTarget` is an optional `uri-reference`, so a relative
`Location` value can be represented. If present, the response status must be
one of 300, 301, 302, 303, 307, or 308. A redirect is never followed
automatically; the returned target requires a new exact-URL approval.

A 3xx response without a usable redirect target may be represented without
inventing one. This does not relax DNS/IP binding, transport warnings, response
caps, or the fresh-approval rule.

### Case-Insensitive HTTP Scheme Representation

The `web_fetch.url` pattern accepts HTTP and HTTPS schemes regardless of ASCII
letter case. Runtime URL parsing and security checks remain authoritative.
This changes no network permission.

### Search Ledger Send-Time Evidence

Only `status="reported"` requires `sentAtUtc`. `possibly_sent` and `uncertain`
may carry a timestamp when evidence exists, but must not fabricate one merely
to satisfy the Schema. The durable reservation and dispatch ordering remain
unchanged.

### Edit Occurrence Static Check

When `replaceAll` is absent or false, a supplied `expectedOccurrences` must be
exactly 1. Runtime still performs the authoritative actual-match count and
rejects zero or multiple matches before writing.

## Not Confirmed

This ADR does not confirm:

- changing `read_file.offset` and `limit` to 1-based line semantics;
- `ask_user` request/result type correlation or option-membership behavior;
- background stream ordering or cursor semantics;
- new `apply_patch` result states (`not_attempted`, `outcome_unknown`);
- enabling `delete_path` or `rename_path`;
- replacing the merged review descriptor with separate Request, Result Payload,
  and Result Envelope schemas.

Those remain pending in `docs-check/` and require further contract review.

## Consequences

- `AGENTS.md`, the maintained contracts, and the review index must reference
  this ADR.
- The reviewed Schema file in `docs-check/` may carry the static corrections,
  but its overall status remains partially confirmed and not frozen.
- Passing JSON Schema meta-validation and targeted negative checks does not
  close any G01-G10 engineering gate or authorize implementation.

