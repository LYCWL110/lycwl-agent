# ADR-0014: Adopt Remaining V1 Behavior Contracts

- Status: Confirmed design
- Date: 2026-10-31
- Owner: [V1_BEHAVIOR_CONTRACTS.md](../architecture/V1_BEHAVIOR_CONTRACTS.md)
- Related: ADR-0010 through ADR-0013; V1_CONTRACTS C01-C03/C05-C06/C09-C10

## Context And Explicit Confirmation

The user requested working through the remaining architecture decisions.
Revision 2 of `docs-check/ARCHITECTURE_PENDING_REVIEW.md` supplied concrete
policies for groups 1-4 and 7-9, plus supplements A/B for details left open by
ADR-0013. The assistant presented the nine-row summary, highlighted limited
delete/rename scope and the cost of conservative replanning, and asked for
unified confirmation. The user replied “可以”.

This adopts that review package, including its thresholds, scope restrictions,
and retained evidence gates. It authorizes documentation consolidation only.
It does not authorize coding, dependency installation, Git operations, real
credential access, paid requests, native probes, or activation of real tools.

The accepted pre-adoption source was 43,571 bytes, SHA-256:

```text
C3961FE9A0DEC1654516F28D53A3A2C2D937B62301B3F96D5AF4BFD069550C66
```

The file is moved to the owning architecture location above. Status, links,
and formerly pending wording are reconciled without changing the accepted
behavior. No second confirmed copy remains in `docs-check/`.

## Decision

| Group | Adopted behavior |
| --- | --- |
| 1 | One question per call; correlated typed answers; distinct decline/cancel/unavailable; closing a panel keeps waiting |
| 2 | Explicit 1-based line reads with bounded full-file evidence; stream-preserving background records and execution-bound cursors |
| 3 | Preflight and serial per-target accounting; stop on failure/cancel/unknown; limited delete and same-volume no-overwrite rename |
| 4 | Finite credential representations, visible retired-key protection, purpose/slot-bound adapter authentication, and a high-risk environment candidate baseline |
| 5 detail | Workspace-local hierarchical AGENTS.md discovery, bounded sourced snapshots and explicit other-document reads |
| 6 detail | Durable FIFO, separate commands, conservative cancellation of undispatched calls on consumed input, restart/terminal handling |
| 7 | Bounded no-progress detection; 90s first-effective-event and 60s idle limits inside the existing 180s attempt cap |
| 8 | Neutral authoritative history and route-bound private items; validated history rendering for a new Provider Run |
| 9 | Explicit compatibility/migration rules preserving originals, and revision/hash conflict detection for shared settings saves |

Exact selected names, limits, encodings, command/event semantics, and failure
paths are maintained in the owner. Serialized schemas and cross-field checks
must still be written and reviewed against that behavior.

## Evidence And Alternatives

The owner records locked OpenCode and Miyu commits, rechecked file blob
identities, and the previously read book sections. Reference observations are
not a universal security audit, proof of Windows support, or authority to
import conflicting parallelism, early tool dispatch, or automatic route changes.
Candidate high-risk names and initial authentication targets are not evidence
that the complete catalog or every SDK adapter has been reviewed.

The user selected the proposed tradeoffs:

- Keeping a closed question pending avoids treating dismissal as an answer;
  explicit refusal/cancellation still lets that question terminate.
- Bounded full-file snapshots simplify consistent evidence but reject files
  above 5 MiB; this does not promise arbitrary large-file line reads.
- Serial stop-on-failure preserves partial facts without claiming rollback.
  Recursive deletion, cross-volume move, replacement rename, and ambiguous
  reparse targets are excluded from the selected built-in scope.
- Retaining old credential versions for protection supports restart/history
  safety; the TUI must disclose retained protective values and cleanup rules.
- Replanning every undispatched old call after consumed ordinary input is
  more conservative than retaining an unchanged call's approval. It may
  increase model rounds and reapprovals.
- Explicit configuration conflicts avoid silent lost updates at the cost
  of user reconciliation. Migrations require a concrete separately accepted
  plan rather than speculative migration infrastructure.

## Reconciliation And Remaining Gates

ADR-0013 remains the source of the prompt/input trust boundaries. This ADR
resolves its discovery/queue policy gaps and refines its approval-retention
possibility: under the selected ordinary-input path, undispatched old calls are
cancelled and their unused grants revoked; a new call needs normal new approval.
The generic C02 unchanged-operation rule still applies outside that path.

ADR-0011/0012 historically did not select line slices, question correlation,
background cursors, or extended batch states; this later confirmation does.
Delete/rename's partial-completion design gate is closed within the limited
scope, while executable schemas, G05/G06, and explicit stage coding authority
remain prerequisites to real use.

Keep open: catalog snapshots and complete variable/adapter evidence, SDK event
and history fixtures, executable Request/Payload/Envelope/Command/Event schemas,
JCS dependency authorization, and G01-G10. User acceptance cannot verify those
external facts or turn proposed tests into passing results.

## Reassessment

If concrete schema review or engineering tests expose a contradiction, pause
affected implementation and return the behavioral choice to the user.
Threshold tuning must retain the attempt/Run budget and no-replay boundaries.
Do not silently weaken credential protection, trust rules, or unknown outcomes.
