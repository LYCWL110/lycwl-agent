# ADR-0034: Neutral History, Provider-Private Replay And Two Real Defects

- Status: Confirmed implementation of already-confirmed section 8 design
- Date: 2026-11-05
- Related: V1_BEHAVIOR_CONTRACTS.md section 8; ADR-0028

## Context

Section 8 says the authoritative history stays provider-neutral, while reasoning
text, signatures and opaque items are bound to the routing that produced them and
never migrated across providers or credential identities.

Implementing it exposed two defects that had been invisible because the demo
provider ignores its input.

## Defect 1: The assistant turn was never in the history

`ProviderConversationItem` had only `user` and `tool_result`. The coordinator's
loop appended tool results but never the assistant message that requested them, so
after the first tool call the conversation answered calls the model had never
made. Against a strict adapter that is an invalid protocol history; against a
lenient one it silently loses the model's own prior turn.

Fixed by adding an `assistant` item carrying text plus the requested tool calls,
appended right after `model_response_validated`. Its placement matters: it must
precede the tool results that answer it.

## Defect 2: The provider received a live reference to the conversation

`completeWithBoundedRetries` passed the Run's `conversation` array directly.
Because the Run keeps appending to that same array, a provider that stored the
request — as tests and any request-logging adapter do — would observe later turns
inside a request it had already been sent. Two consequences:

- the recorded request was not what was sent, which makes any later audit wrong;
- a retry would see the mutated array rather than the original payload.

Fixed by passing `[...conversation]`. The tests caught this only after the
assistant item was added, because before that the mutation happened to be invisible
in the assertions.

## Decision

### Neutral history (`domain/model-request/neutral-history.ts`)

`validateNeutralHistory` enforces the invariant that makes a history legal: every
`tool_result` answers a call the preceding assistant turn actually made, calls are
not duplicated, and no user or assistant turn is inserted while a call is
unanswered. Denied, cancelled and `outcome_unknown` results are valid closers — the
point is the pair exists, not that the call succeeded.

### Private replay

`decidePrivateReplay` distinguishes three cases that are easy to conflate:

| Situation | Result |
| --- | --- |
| same route | signatures and opaque items replay in order |
| same provider, different credential revision | `credential_identity_changed` |
| different provider, adapter requires signatures | `protocol_history_incompatible` |
| different provider, adapter tolerant | foreign blocks are skipped, never forged |

A block with `returnedByVendor: false` is refused outright: replaying vendor data
the vendor never produced would be forgery, and a signature is the clearest case.

`reasoning_summary` is returned in a **separate** list from `replayable`, so a
caller cannot accidentally promote a visible summary into a system position. It is
ordinary sourced material.

### Superseded calls

When queued input supersedes an undispatched response, each cancelled call now gets
a `cancelled` tool result appended **before** the new user message. Order is the
whole point: appending it after would answer a call across a turn boundary and
produce an illegal sequence. This was caught by an existing queued-input test,
which is the correct outcome — the test was right and the new code was wrong.

## What This Is Not

- **No persistence of private blocks.** `PrivateBlock` carries an `attachmentId`
  reference; the attachment store, R03 handling and size limits for that content
  are not implemented.
- `crossProviderHistory` is currently an identity copy. Real cross-provider
  rendering needs per-adapter fixtures and G07 verification; the function exists so
  the policy point has a name, not to claim the rendering works.
- Adapters are not yet required to declare `requiresSignatures`; there is one
  adapter and it does not use private blocks at all.
- `reasoning_summary` inclusion is not wired into the prompt renderer.

## Consequences

- The history the model sees now includes its own prior turns and is internally
  consistent, which is a prerequisite for any real provider.
- A future request-logging adapter cannot accidentally record a mutated history.
- No behaviour is claimed for cross-provider resume; it is explicitly unverified.

## Reassessment Conditions

Wire private block storage only with the attachment store and R03 rules. Add
per-adapter cross-provider fixtures with G07 before claiming that path works.
