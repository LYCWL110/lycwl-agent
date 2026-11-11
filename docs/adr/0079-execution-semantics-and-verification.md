# ADR-0079: Declare tool execution semantics and verify uncertain outcomes

- Status: Accepted (2026-11-08)
- Related: ADR-0005 (C01-C02), ADR-0078 (edit verification), V1_BASELINE.md section 3

## Context

`outcome_unknown` was recorded and nothing else happened. A timeout does not prove
failure: the operation may have run and its result may have been lost. The Harness
had no way to establish which, so the model was told "unknown" and left to guess —
and a guess in either direction is wrong. Assuming success reports a state nobody
observed; assuming failure invites a retry that duplicates a side effect.

`sideEffectClass` also carried no retry information. A read and a payment were both
just a class, with nothing saying whether repeating one is safe.

The ACI review listed this as the highest-value remaining gap, because it is a
correctness defect rather than a missing convenience.

## Decision

### Semantics are declared, not inferred

`ToolDefinition.semantics` carries `{ idempotent, retry }`. Absent falls back to
`defaultSemantics(sideEffectClass)`, which is conservative:

| Class | Idempotent | Retry |
| --- | --- | --- |
| `read_only` | yes | safe |
| `filesystem_mutation` | yes (in effect) | conditional |
| `process_execution` | **no** | never |
| `external_request` | **no** | never |

A class whose operations are sometimes repeatable is treated as not repeatable.
Assuming idempotence is the mistake that duplicates a side effect, so the default
errs the other way. A tool that knows better declares it.

`mayRetryAutomatically` permits a `safe` retry only when the operation is declared
idempotent, and never decides a `conditional` retry — that belongs to the caller
holding the invocation.

### Verification is a capability, not data

The first design made verification a data record: a probe tool name, an argument
transform, and an interpreter. That was wrong and was discarded before it shipped.
The probe would have re-invoked a tool, and for `delete_path` the "verification"
would have been a second delete — the exact mistake verification exists to prevent.

`ToolExecutor.verifyOutcome` is a method instead. Only the adapter knows how to
inspect its own effect without repeating it.

Implemented for `delete_path` and `rename_path`, which reuse the preflight
inspectors already present:

- **Delete**: every target absent means applied; every target present means not
  applied; a mix means inconclusive.
- **Rename**: source gone and destination present means applied; both unchanged
  means not applied; anything else means inconclusive, because guessing which half
  completed would be a fabrication.
- **Invalid arguments or a throwing check** return null or inconclusive, never a
  verdict.

`shell` declares `idempotent: false, retry: "never"` and carries guidance instead of
a verifier: the Harness cannot enumerate the paths a command wrote or the services it
called, so it cannot check them. That limit is stated rather than papered over.

### The outcome is not rewritten

Verification records `tool_outcome_verified` with the verdict and appends the answer
to the result text. The tool result keeps status `outcome_unknown`: the effect may
be present, but the execution outcome itself was never observed. A verified "applied"
is a statement about state, not a retroactive success.

## Consequences

- `domain/tool-invocation/execution-semantics.ts` owns the rules and the resolution.
- `ports/tool-executor.ts` gains `verifyOutcome` and `uncertaintyGuidance`.
- `tool_outcome_verified` event records what the check established.
- `delete_path` and `rename_path` verify; `shell` explains why it cannot.

## Known limitations

- **Only two tools verify.** Write and patch tools have no verifier yet; they report
  the generic guidance.
- **A partial batch stays inconclusive.** Nothing distinguishes "two of three
  applied" from "one of three", because the probe answers a yes/no question about
  each target rather than reconstructing order.
- **Verification is not retried.** A check that fails transiently leaves the outcome
  unknown rather than trying again, which is conservative but means a flaky
  inspector produces less information.
- **`process_execution` has no verification at all** and is not expected to get one:
  the Harness cannot observe arbitrary command effects.

## Reassessment conditions

Reopen if write and patch tools need verifiers, if a partial batch needs per-target
resolution, or if a tool is found whose effect cannot be checked but which claims
idempotence.
