# ADR-0069: Three-Protocol Reasoning Discovery

- Date: 2026-11-07
- Status: Authorized by the user's request to select a discovery method for all three protocols
- Owner: V1_DESIGN_SUPPLEMENTS S02
- Related: ADR-0063, ADR-0067, ADR-0068; V1_CONTRACTS C03

## Context And Evidence

The user supplied metadata and generation-probe alternatives and requested a
working method for Chat, Responses and Anthropic Messages. The existing parser
did not read `effort.supported_levels/default_level`, discarded model defaults,
and kept Anthropic effort disabled.

Primary references consulted on 2026-11-07:

- DeepSeek model list describes `effort.supported_levels` and `default_level`:
  <https://api-docs.deepseek.com/api/list-models>.
- Anthropic model retrieve documents `capabilities.effort`, its overall supported
  flag and per-level supported flags:
  <https://platform.claude.com/docs/en/api/models/retrieve>.
- Anthropic Messages documents `output_config.effort` independently of enabling
  thinking: <https://platform.claude.com/docs/en/build-with-claude/effort>.
  The upstream model capability types are also recorded in
  <https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts>.
- OpenAI Chat and Responses document their respective effort fields and current
  enum values:
  <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>
  and <https://developers.openai.com/api/reference/resources/responses/methods/create>.

These document schemas, not tested behavior of a particular configured relay.

## Decision And Alternatives

Follow-up ADR-0070 authorizes frozen, visibly unverified reference choices for
exact model/protocol matches without upstream declarations. It supersedes the
default-only policy for those matches; probing and compatibility limits remain.

Choose read-only list metadata followed by selected-model detail lookup, with
an ephemeral bounded cache. S02 owns shapes, per-protocol values, request
invalidation, cache boundaries and selection semantics.

Add `max` and the Anthropic `output_config.effort` mapping. This explicitly
supersedes the earlier disabled-Anthropic behavior; it adds no automatic
thinking-budget mapping. An upstream default remains information: `default`
continues to omit the effort parameter.

Keep missing support unknown. A generation response or HTTP 200 can indicate
parameter acceptance without establishing actual execution, and repeated probes
can consume budget. Do not implement automatic generation probing, infer levels
from model names, or persist learned compatibility across Sessions. Catalog hints
do not upgrade the frozen compatibility matrix.

## Validation And Remaining Work

Use deterministic parser, transport-injection, cache/race, credential-boundary,
configuration-to-adapter and TUI tests. No real key or paid upstream request is
used. Actual relay metadata availability, effective parameter behavior and
full Provider/G01/G08 acceptance remain unverified.
