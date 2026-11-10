# ADR-0022: V1 Architecture Design Closure

- Status: Confirmed design by explicit user delegation; documentation only
- Date: 2026-11-01
- Owner: [V1_CONTRACT_CLOSURE.md](../architecture/V1_CONTRACT_CLOSURE.md)
- Related: ADR-0001–0021; C02/C03/C05–C10; P02/S01/S03; SR01–SR08

## Authority And Scope

After the remaining-work inventory and recommendation to close SR01–SR08,
the user explicitly instructed: “就是确立第一版的架构，按照你的建议确定”.
This delegates the remaining design choices within confirmed V1 boundaries.
It does not explicitly select unpresented vendor products, pay for tests,
authorize dependencies or say “开始编码”.

Select the concrete closure rules in the maintained owner, including the
remaining small parameters. This record does not pretend those exact fields/
values were individually confirmed in an earlier conversation.

## Decision

| Gap | Selected resolution |
| --- | --- |
| SR01 | Direct dispatch-to-reserved-ledger binding with search execution identity; preserve non-atomic logs and strict non-send proof |
| SR02 | Separate pending-approval/disclosure cancellation events, immutable terminal decisions and ordered grant/permit invalidation |
| SR03 | Durable safe validation records scoped to exact credential revision/owner/purpose/route; enforce compatible owner-purpose pairs |
| SR04 | State-specific background events and LSP initialization/termination evidence; stop request is not stop completion |
| SR05 | Uniform attemptRef across model/compaction events, checked against prior reservation and shared C05 budgets |
| SR06 | Per-segment source-to-rendered-block mapping, typed ranges and sensitive lineage; construction is not proof of send |
| SR07 | storage_prohibited evidence branch with safe execution/blocking facts and no fabricated raw attachment |
| SR08 | Frozen sample plans separate from actual observations, retaining unrun/unknown/negative results and denominators |

Select minimum timeout 1000 ms, at most 16 requested environment-grant names,
an optional 100-code-point background display label, and explicit rejection of
legacy new-file lineEnding=preserve. Existing defaults/maxima and preservation
of edited files remain in force. These are chosen initial limits, not measured
optimums; the owner defines units, validation and scope.

The current identified V1 architecture/behavior choices are settled. Treat
Schema reconciliation, source/compatibility evidence, dependency/version
selection, implementation and platform/product validation as remaining
deliverables. Do not call Stage 0 complete, adopt existing JSON wholesale,
declare capability/quality support or reopen settled policy simply because
implementation is absent.

## Rationale And Alternatives

Direct search binding is clearer than inferred joins; it still cannot make
two logs atomic or establish non-send from missing records.
Independent cancellation events keep user decisions distinct from Runtime
invalidation and avoid overwriting approved history.
Validation records are stronger than self-reported test codes without
collecting secrets or adding automatic paid verification.

State-specific facts prevent launch/stop/cleanup conflation. Repeated typed
attempt references cost extra metadata but make budget/recovery checks explicit.
Per-segment coverage is more work than group-level offsets, but prevents
ambiguous source, unit and disclosure claims.
Separate prohibited-storage evidence and unrun evaluation plans avoid
fabricated attachments, Runs, successful checks or zero-charge facts.

Keeping every gap labelled “policy pending” would prolong architecture
discussion without resolving the known ambiguity; declaring all schemas and
gates complete would overstate the evidence. The selected closure fixes
design while preserving concrete delivery and validation gates.

## References And Limits

The existing locked OpenCode/Miyu, local Claude snapshot and already-read book
observations remain indexed in
[REFERENCE_EVIDENCE_20261031.md](../architecture/REFERENCE_EVIDENCE_20261031.md).
Book p.76 (event trail/checkpoints), pp.126–128 (classified recovery),
p.199 (exact evidence/matching chain) and pp.264–266 (independent verification)
support the separation of facts and claims. They do not prescribe these event/
field names or numeric limits. This adoption adds project design choices,
not a new source audit, PDF extraction, supplier guarantee or dependency review.

The older C07 wording permitting surcharge acceptance is reconciled to the
later ADR-0021 rule: V1 rejects surcharge/unclassified searches; ordinary
approval never enables them. The latest confirmed decision is preserved.

## Consequences And Follow-up

Synchronize AGENTS, owners and review indexes. Preserve historical JSON bodies,
resource IDs and examples for comparison; they need a future versioned revision,
cross-record validation and review before affected coding.
SR01–SR08 design resolutions are selected; their serialization/semantic/
engineering closure is not delivered by this record.

Package/version reviews, LSP validation combinations, evaluation configuration
and actual paid-test budget remain implementation/evaluation-plan inputs.
User authorization is still required for the relevant stage and side effects.
G01–G10 remain OPEN; RT-01–53 remain unexecuted.
Reassess on evidence of incompatibility, unachievable guarantees or a proposed
behavior change, not merely to add speculative future infrastructure.
