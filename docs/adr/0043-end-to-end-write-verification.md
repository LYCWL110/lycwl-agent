# ADR-0043: End-To-End Write Verification

- Status: Implemented and verified locally
- Date: 2026-11-05
- Related: ADR-0042

## Context

ADR-0042 recorded an explicit gap: the wire tests proved the model is *offered*
the write tools, but nothing drove an approved write through the coordinator to
disk. That left the write chain as the only claimed-and-unverified capability in
the build.

## Decision

Add `tests/integration/write-chain-e2e.test.ts`, which drives the real executor,
the real write adapter, the real approval suspension and the real coordinator
against a real temporary directory.

Cases:

| Case | Asserts |
| --- | --- |
| approved `create_file` | file absent before approval, exact content after, result `succeeded` |
| denied `create_file` | file absent, exactly one `tool_execution_denied` |
| approved `edit_file` | target text replaced, surrounding lines preserved |
| `edit_file` with an absent match | file unchanged, result `failed` |
| approved `apply_patch` | either the patch applied or the file is untouched; never "succeeded with no change" |
| read-only build | `getDefinition` returns null and execute returns `tool_unavailable_in_build` |

## Details Worth Recording

**Nothing is written before approval.** The test reads the target immediately after
the Run suspends and asserts the file does not exist. That is the check that makes
"approval gates the write" a fact rather than a claim about control flow.

**The patch case is written defensively on purpose.** It accepts either outcome but
forbids the dangerous one: reporting success while leaving the file unchanged. A
test that only accepted "applied" would be asserting my patch-format guess rather
than the property that matters.

**Denial still completes the Run.** The run finishes `completed` with a failed tool
result, which matches the confirmed rule that a denial applies to that invocation
and does not fail the Run.

## Verification

- 1070 tests pass across 229 suites; the vitest suite runs 12 render tests.
- `pnpm run verify` exits 0.
- `apply_patch` applied successfully in this run, so the file content changed; the
  test also covers the untouched-on-failure path by construction.

## What This Still Does Not Prove

- **Crash safety.** A write can still be interrupted by power loss; G05/G06 own
  that, and this test runs on a healthy filesystem.
- **Model behaviour.** The provider is scripted. This proves the Harness handles an
  approved write correctly, not that a real model requests the right edit.
- **Concurrent modification.** The precondition re-check is exercised by unit tests,
  not by racing two writers here.
- Shell, background, LSP and web tools remain disabled, and there is no streaming.

## Consequences

- The write chain is no longer an unverified claim.
- A future change that lets a write slip through before approval, or that reports
  success without changing the file, now fails a test rather than a review.

## Reassessment Conditions

Extend this to a G05 crash-injection run when that gate is authorized. Do not treat
a passing healthy-path test as evidence of crash consistency.
