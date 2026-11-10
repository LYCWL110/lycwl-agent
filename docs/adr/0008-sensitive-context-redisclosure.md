# ADR-0008: User Consent For Sensitive Context Redisclosure

Date: 2026-10-30.
Status: accepted by the user's direction that authorization requires user
agreement. Policy/documentation only, not feature coding or permission to
disclose any actual data in this working session.

## Problem And Basis

C03 fixes model routing per Run and revisions credentials per attempt. A new
credential identity may represent a different account or tenant. Already-read
sensitive material can remain in conversation history or a summary, so absence
of a new file read does not establish consent to send it under the new identity.

Existing sensitive-read approval warns about disclosure to the selected
Provider. Existing C02 requires reapproval of unused grants when material
conditions change. The user resolved the remaining policy question with
"授权由用户同意": authorization must come from explicit user agreement.
This ADR records that decision, not a new reference-project comparison.
No book passage or reference implementation is claimed to prescribe this
exact redisclosure contract.

## Alternatives And Tradeoffs

1. Carry old consent forward automatically. Fewer prompts, but conflates
   permission for the old destination identity with a new one.
2. Require user consent before redisclosure. Preserves user authority at the
   identity boundary; adds approval interaction and context-provenance work.
3. Prohibit redisclosure even with consent. Simplifies a conservative boundary
   but removes the user's ability to authorize legitimate continuation.

The user's direction selects option 2. Approval is necessary, not an override
of other safety rules; do not select a silent automatic-transfer default.

## Decision

After credential-account identity changes, sensitive material already present
in context requires explicit user agreement before sending to that destination.
Do not infer agreement from saving credentials, changing configuration,
ordinary ResumeRun, previous read approval, model text, or a context summary.
Until agreement, do not send the affected material. Refusal is not permission
to send it or silently change routes.

The trusted preview must identify the intended Provider/model/endpoint,
credential identity/revision without secret values, and the sensitive material
covered by the request. User consent remains tied to what was actually shown;
material scope/destination changes require renewed agreement. Detailed coverage,
command/event fields, and invalidation rules remain contract deliverables.

Summaries and derived history do not erase the source material's authorization
requirements. Preserve execution facts: a consent decision does not replay
completed tools or change historical outcomes. This does not relax R03's owned
Provider-key prohibition or permit an egress-guard bypass.

Configuration/recovery waits still require explicit resume under C01. A resume
control may not silently stand in for disclosure consent; any combined
interaction must explicitly obtain both and pass the independent checks.
No new exact combined-command schema is selected here.

## Impact And Remaining Contracts

Context provenance, Provider attempt binding, permissions, coordinator, and
TUI must share the consent boundary. Recheck before affected main/auxiliary
model sends; compaction cannot become an unapproved disclosure route.
No new secret scanner, identity-discovery service, or generic information-flow
framework is approved by this decision.

Define the identity/revision comparison, consent scope/lifetime and source
references, summary provenance, refusal/wait transitions, races, restart/replay,
and pre-send validation before affected implementation. Do not infer same-account
identity merely because providerId is unchanged. Behavioral alternatives found
during contract work must be brought back to the user.

## Acceptance

Under separate implementation authorization, use fake Providers and synthetic
sensitive content. Test that a credential identity change blocks affected sends
until a matching user consent, that refusal sends nothing affected, and that
save/resume/old approvals cannot substitute for agreement. Include summaries,
auxiliary compaction, repeated replies, identity changes after preview,
cancellation, and restart. Verify no completed side effects are repeated and
owned Provider keys remain forbidden even after user consent.

No behavioral tests have run. G01-G10 remain OPEN. This decision settles the
identified policy direction, not every schema or future architecture question.

## Reassessment

Reopen if context provenance cannot support reliable consent checks, supported
Providers introduce new routing/identity boundaries, or future multi-Agent/
remote execution changes destination ownership. User confirmation is required
before widening consent or weakening the pre-send boundary.
