# ADR-0018: Provider Evidence And Quality Applicability

- Status: Confirmed design; documentation only
- Date: 2026-11-01
- Owners: [V1_BASELINE.md section 6](../architecture/V1_BASELINE.md);
  [V1_EVALUATION_AND_RELEASE.md sections 3.3/5.4](../architecture/V1_EVALUATION_AND_RELEASE.md);
  [V1_DESIGN_SUPPLEMENTS.md S02](../architecture/V1_DESIGN_SUPPLEMENTS.md)
- Related: ADR-0001, ADR-0015–0017; C03; G01/G07/G08

## Context And Confirmation

The user requested the next architecture discussion without coding. The
presented proposal covered compatibility-evidence identity, separate
compatibility/quality presentation, quality applicability after changes,
and a possible evaluation-budget arrangement. Its explicit confirmation
request covered the first three items; the user replied “可以”.

Adopt those first three directions. The fourth item's new budget allocation
is not adopted by this record. Existing paid-test approval, accounting,
frozen-sample and no-cherry-picking rules continue unchanged. The first actual
quality Provider/model/parameters and amount remain unselected.

## Decision And Maintained Owners

V1_BASELINE section 6 owns the concrete configuration scope of compatibility
evidence. Neither the Provider name nor a successful response on one protocol
proves another route/capability. Keep the frozen matrix and existing Run
bindings; add no optimistic dynamic capability-learning or silent fallback.

V1_EVALUATION_AND_RELEASE section 3.3 owns independent compatibility/quality
support statements, with S02 owning TUI presentation. Necessary verified
tool-calling and valid context limits remain executable-selection conditions.
An honest quality-unmeasured display neither reduces Provider coverage nor
establishes release readiness.

The evaluation document's section 5.4 owns applicability after model/route/
parameter or implementation changes and observable service drift. Preserve
historical results; relate current claims to the actual tested configuration
and dates. Rolling aliases retain their reproducibility limitation. No fixed
age-only expiry, automatic paid re-evaluation or current-Run mutation follows.

The existing per-configuration sampling counts, thresholds, process rules
and engineering gates remain in force. This decision does not declare any
Provider, model, SDK or capability compatible or tested.

## Reference Evidence And Alternatives

The preceding read-only discussion is recorded in
[the reference evidence addendum](../architecture/REFERENCE_EVIDENCE_20261031.md).
At the locked OpenCode revision, the inspected capability test separates
protocols and checks effective request options and responses. The locked
Miyu path distinguishes a returned response ID from continuation support,
with an optimistic endpoint-keyed negative record. Borrow the distinction;
do not import that fallback/cache behavior as our capability authority.
The local Claude snapshot's inspected capability query has eligibility
conditions; it does not establish broad compatibility. Its correspondence
to official release source remains unverified.

The previously read book p.205 supports paired/repeated comparisons and
pp.264–266 support independent verification and separating stable execution
from candidate improvement. They do not prescribe these specific UI labels,
the identity tuple or expiry policy.

A single supported badge is simpler but conflates transport/capability
evidence with task quality. Provider-only evidence is cheaper to curate but
can overgeneralize across routes. Fixed expiry is simple but passing time
does not establish a service change, while rolling aliases prevent promises
of permanent reproducibility. The selected scoped statements cost additional
evidence maintenance and may leave limitations or unmeasured quality visible.

## Remaining Work And Reassessment

Deliver the complete locked catalog/matrix, actual capability/SDK evidence,
configuration/report identity and applicability serialization, positive and
negative fixtures, and TUI rendering/validation. Test non-transfer across
protocols/options, unmet executable-selection prerequisites, quality-unmeasured
presentation, alias/drift limitations and preservation of historical reports.
These are future acceptance requirements, not implemented or executed tests.

No pending JSON resource is adopted or revised here. Reassess when matrix
evidence conflicts with a selected route, new protocol/parameter behavior
invalidates the evidence scope, or a future proposal changes display,
automatic learning or re-evaluation behavior. G01–G10 remain OPEN; RT-01–53
remain unexecuted. No code, dependency installation, Git operation, credential
access, paid request or native probe is authorized.
