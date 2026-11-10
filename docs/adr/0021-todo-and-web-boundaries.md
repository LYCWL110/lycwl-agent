# ADR-0021: Todo And Web Boundaries

- Status: Confirmed design; documentation only
- Date: 2026-11-01
- Owner: [V1_BEHAVIOR_CONTRACTS.md sections 2.4–2.6](../architecture/V1_BEHAVIOR_CONTRACTS.md)
- Related: ADR-0002, ADR-0014, ADR-0017, ADR-0019–0020; C06/C07; G04/G05/G08/G10

## Context And Confirmation

The user requested the next architecture discussion without coding.
The proposal explicitly presented four groups: Todo limits/state/history,
WebSearch query/count/depth and language/location configuration,
pre-send handling of surcharges and query encoding, and restricted WebFetch
headers/no login session. The user replied “可以”. Adopt all four groups,
including the proposed numerical limits; do not adopt entire pending Schemas.

## Decision And Maintained Owner

Behavior section 2.4 owns Session-scoped whole-list Todo replacement,
100 items/500 Unicode code points, unique stable item identity and input order,
pending/in_progress/completed/cancelled with at most one in progress,
retained completed history and explicit clearing. Restoring a list does not
dispatch tasks. Planning completion is separate from execution/verification,
and Todo cancellation neither cancels a Run nor proves side-effect safety.

Section 2.5 owns bounded unchanged logical queries, count 1–10/default 10 as
maximum delivered organic results, fixed vendor depth 10 and no automatic
replenishment. Reviewed language/location codes and user-managed defaults are
visible in approval; missing necessary configuration waits rather than guessing.
Reject surcharge or unclassified requests before send under reviewed rules;
do not silently strip operators, expand parameters or treat ordinary approval
as surcharge consent. Preserve approved query meaning through vendor encoding.
Actual rules/code tables/mapping and G10 evidence remain to be delivered.

Section 2.6 owns GET with only optional Accept/Accept-Language model headers,
512 ASCII bytes per value, control/duplicate-name rejection and Harness-managed
User-Agent. No model-supplied auth/Cookie/Host/custom headers, browser identity,
Cookie persistence/replay or automatic challenge response. Bind effective
request details to approval, preserving redaction, address checks, limits
and the existing prohibition on following any redirect automatically.
This restriction does not remove the separate approved search-adapter
authentication or intended-Provider adapter authentication.

C07 still owns durable quota reservation, sending/billing uncertainty and
verified non-send correction. Query rejection does not authorize a new paid
attempt or release any old uncertain reservation.

## Evidence, Alternatives And Tradeoffs

The preceding discussion's actual read-only checks are recorded in
[reference evidence section 10](../architecture/REFERENCE_EVIDENCE_20261031.md).
Locked OpenCode/Miyu Todo paths include cancelled status; the local Claude
Todo path clears the displayed list when all items are completed. Borrow
explicit state/history boundaries, not every project's storage, mutation or
permission design. Source comments are not independently reproduced bug tests;
the local snapshot's correspondence to official source remains unverified.

OpenCode's inspected WebFetch constructs fixed headers and can check and
continue redirects. The local Claude paths include different permission and
Web-model behavior. Neither overrides our exact-invocation approvals, all-hop
redirect rule, selected search backend or bounded paid-search accounting.
Miyu's inspected search descriptor labels trust/permission but does not prove
runtime enforcement.

The official DataForSEO page inspected in the preceding discussion describes
surcharges for listed query operators, possible additional charges beyond
depth 10, language/location codes, and special percent/plus decoding.
These observations motivate explicit pre-send classification and encoding
fixtures; they do not supply a frozen/current fee contract or G10 approval.
The already-read book's persistence, failure/evidence and exact-matching
principles remain relevant but do not prescribe these numeric limits.

Automatic Todo clearing reduces clutter but loses the visible completed plan;
retention plus explicit clearing is more traceable. Requiring exactly one
active item misrepresents waiting/all-done plans; at most one fits single-Agent
work. Arbitrary parameter/header passthrough is flexible but complicates
approval, cost and identity boundaries. Silent operator removal changes the
approved query; unrestricted surcharge sending conflicts with the selected
no-extra-charge policy. The chosen restrictions may require explicit user
configuration or leave some searches/sites unavailable.

## Remaining Work And Reassessment

Deliver complete Todo state/identity/replay schemas and fixtures; reviewed
vendor language/location tables and their configuration/identity/update
contracts; fee-rule snapshots and encoding/request mappings; restricted-header
schemas, canonical effective previews and no-auth/Cookie/network fixtures.
New cancelled Todo state, code-based location, fixed depth/cost classification,
ASCII-byte header limits and duplicate-name rejection are not fully expressed
by the pending JSON. Preserve its bodies, resource IDs and structural examples
as historical review material; numeric agreement does not adopt the resource.

Remaining Shell minimum timeout/environment-entry and background-label limits,
parser dependency selection, legacy file-format fields, SR01–SR08 and other
serialization/evidence gaps are outside this adoption.
Reassess when vendor changes affect cost/query meaning, code tables cannot
represent the configured destination, or a future proposal enables surcharge
searches, authenticated fetching or a different Todo model.

G01–G10 remain OPEN; RT-01–53 remain unexecuted. This adoption authorizes
documentation updates only, not feature coding, dependency installation,
Git operations, credential access, paid/model requests or product tests.
