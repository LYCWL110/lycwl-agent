# ADR-0068: Upstream Reasoning Levels

- Date: 2026-11-07
- Status: Authorized by the user's follow-up request
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE section 6
- Related: ADR-0063, ADR-0067; V1_CONTRACTS C03

## Context And Evidence

The user noted that the configured upstream may not accept every local reasoning
effort value and requested discovery before selection. Offering the complete enum
without qualification made model-specific support unclear.

The official OpenAI Models API object exposes identifiers, creation time,
ownership and object type, without a supported effort list:
<https://developers.openai.com/api/reference/resources/models/>.
OpenRouter documents a model-level `reasoning.supported_efforts` declaration,
including null for unrestricted effort values:
<https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>.
These pages were consulted on 2026-11-07. They establish metadata semantics,
not compatibility of a user's configured gateway, adapter or model.

## Decision And Alternatives

Subsequent ADR-0069 extends discovery to read-only model details and authorizes
the three-protocol effort mapping and `max`. S02 owns the current behavior.

Read explicit effort declarations from the existing authenticated model-list GET.
S02 owns accepted shapes, unknown/manual behavior, invalidation and save rules.
The generic `supported_reasoning_efforts` field is an optional gateway extension,
not a promised standard OpenAI endpoint. Catalog values are restricted to the
existing local enum before reaching the UI. Declarations do not authorize tools,
execute code, change an active Run or become tested capability evidence.

Do not guess support from names, use third-party model rankings as route-specific
evidence, or make generation requests to learn capabilities. Those alternatives
can misrepresent a gateway's behavior or consume a user's budget. Restricting
every unknown model permanently to default would remove deliberate existing
configuration; retain an explicit, visibly unverified manual opt-in instead.
An explicit declaration cannot be broadened through manual mode.

## Validation And Limits

Deterministic regressions cover parsed metadata, malformed/conflicting declarations,
custom-ID metadata merging, selection and filtering, invalid saved efforts,
manual opt-in, connection/protocol changes, stale responses, failed refreshes,
form/browser saving and narrow-terminal rendering. These tests use fixture keys
and mocked HTTP/model responses.

No real upstream or paid model call has run. Model discovery remains unavailable
when an upstream does not publish recognized metadata. Live acceptance of declared
efforts, the full Provider matrix and G01/G08 remain open. Reassess the parser when
an actual supported upstream publishes a different documented representation;
do not expand effort values or protocol mappings implicitly.
