# ADR-0065: Background Delivery Block Was Cancelling Instead Of Waiting

- Status: Fixed; defect was pre-existing
- Date: 2026-11-08
- Related: C10 owned-key guard, C06 delivery; ADR-0064

## Context

`tests/integration/guarded-process-pipes.test.ts` had one failing case,
`wires background capture protection into the production Runtime`. It was
pre-existing: stashing unrelated work and re-running reproduced it.

The test expects a Run whose background output contains a Harness-owned key to end
in `waiting` with `protected_delivery_blocked`. It was ending in `failed` with
`safeCode: tool_cancelled`.

## Cause

The background observer set the delivery-block flag and then called
`abortController.abort()` on the active context.

That abort cancelled the in-flight model request. The cancellation path is checked
before the delivery-block flag, so the Run reported `tool_cancelled` and never entered
the recovery-review wait the flag was supposed to produce. The block was detected and
then discarded by the abort that detected it.

## Decision

Stop aborting. Set the flag only.

The flag is already checked at every safe boundary, including `onRequestStarted` and
after each response. That is where a blocked result must take effect: the current
response finishes, no further call is dispatched, and the Run enters recovery review
with the real reason preserved.

Aborting was also wrong in principle. A blocked payload is a delivery fact, not a
reason to tear down a request mid-flight; the baseline separates execution outcome
from evidence completeness and delivery, and cancelling conflated them.

## A Second Correction, In The Test

After the fix the Run reached `waiting` correctly, but the test still failed: it
asserted that the **last** `tool_execution_finished` had `text === null`.

That assumption was wrong. Once the block is observed, `onRequestStarted` refuses the
next attempt, so the follow-up `background_output` call is never dispatched. The last
finished tool is therefore the launch, which legitimately carries its task id.

The test now asserts the properties that matter: the block is recorded, no finished
result carries the key, and no event anywhere contains it.

## Verification

- 1582 tests pass across 315 suites; the previously failing case now passes.
- The probe used to diagnose it shows the corrected sequence:
  `tool_execution_finished` → `tool_result_delivery_blocked` → `run_waiting`.
- `pnpm run verify` typecheck passes; lint exits 0 at the existing baseline.

## What This Does Not Do

- **No new coverage was added** for the abort-versus-wait distinction beyond the
  existing case; a targeted unit test for the observer would be better than relying
  on one integration scenario.
- The same abort pattern may exist elsewhere; only the background observer was
  inspected.

## Consequences

- A blocked background capture now ends the Run in recovery review with
  `protected_delivery_blocked`, which is what the contract describes.
- The defect is recorded as pre-existing and unrelated to the skill work that
  surfaced it.
- The corrected test asserts the guarantee rather than an incidental ordering.

## Reassessment Conditions

Audit the remaining abort call sites for the same conflation before claiming delivery
blocking is uniformly correct.
