# ADR-0011: Stage 0 Schema Review Decisions

- Status: Confirmed
- Date: 2026-10-31
- Supersedes: none
- Related: ADR-0009, ADR-0010,
  [RUNTIME_TOOL_CONTRACTS.md](../architecture/RUNTIME_TOOL_CONTRACTS.md),
  [V1_CONTRACTS.md](../architecture/V1_CONTRACTS.md)

Later resolution: [ADR-0014](0014-remaining-behavior-contracts.md) adopts the
question, line-read, background-cursor and batch policies historically excluded
below, with limited delete/rename design and retained activation gates.
The complete Schema file still requires reconciliation/review; the exclusions
below describe this ADR's original scope, not current unanswered choices.

## Context

The Stage 0 JSON Schemas were derived from confirmed contracts and reviewed
against Draft 2020-12. The review identified five reversible serialization or
tool-boundary decisions that could be confirmed without resolving the remaining
behavioral contracts for user answers, byte ranges, background streams, or
partial patch execution.

The user confirmed those five items on 2026-10-31. This confirmation freezes
only the decisions listed below. It does not approve the complete Schema file,
authorize implementation, or resolve the three behavioral contract gaps
identified by the review.

## Confirmed Decisions

### 1. Names, Defaults, And Bounds

Keep the currently proposed field names, defaults, and hard limits, subject to
the explicit exceptions and unresolved semantics listed below. Runtime
normalization, not a JSON Schema validator, applies defaults and produces the
canonical invocation input.

This confirms a serialization direction. It does not make JSON Schema `default`
an executable value-injection mechanism.

### 2. New-File Line Endings

For `create_file`, `lineEnding="preserve"` means the supplied `content`
newline sequences are preserved without automatic conversion when creating a
new file. This does not define conversion behavior for overwriting an existing
file; that path remains governed by the applicable file-mutation contract.

### 3. Exact Single Edit

For `edit_file`, `replaceAll=false` requires exactly one match of `oldText`.
Zero matches or multiple matches reject the invocation before any write. When
`expectedOccurrences` is supplied, it must equal the actual match count.

### 4. Non-Atomic Multi-File Patch

`apply_patch` does not promise global atomicity across files. Each target's
actual result must be recorded independently, and a side effect whose outcome
cannot be established must not be represented as a failure with no modification.

The result-state extension `not_attempted` / `outcome_unknown`, continuation
after failure, duplicate-path behavior, and event linkage remain behavioral
contract work. This ADR confirms only the non-atomic, per-target accounting
direction.

### 5. Independent Truncation Reasons

`ToolResultEnvelope.evidence` retains two independent fields:

```ts
rawTruncationReason: "raw_limit" | "blocked" | "capture_interrupted" | null;
modelTextTruncationReason: "model_budget" | "display_limit" | "blocked" | null;
```

Raw evidence truncation and model-facing text truncation must not overwrite one
another. These names are confirmed as the serialization direction; exact
compatibility behavior and negative tests remain implementation gates.

## Not Confirmed

This ADR does not resolve:

- `ask_user` request/result correlation, option-membership checks, free-text
  conditions, or refusal/cancellation representation;
- `read_file.offset` / `limit` byte semantics, invalid UTF-8 handling, or
  Unicode-safe truncation;
- `background_output` stream ordering, cursor semantics, UTF-8 boundaries, or
  invalid-byte handling;
- the `apply_patch` result-state extension and per-patch continuation rules;
- activation of `delete_path` or `rename_path`.

Those remain in `docs-check/` for review and must not be treated as confirmed
merely because related Schema text exists.

## Consequences

- The five confirmed decisions must be reflected in maintained contracts and
  the `AGENTS.md` document map.
- The full JSON Schema file remains a pending-review artifact in `docs-check/`.
- Schema validation checks are not runtime tests and do not close any G01-G10
  engineering gate.
- No functionality may be implemented until the user explicitly authorizes the
  applicable coding stage.

