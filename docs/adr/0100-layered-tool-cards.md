# ADR-0100: Layered Tool Cards For Ambiguous And High-Risk Tools

- Status: Accepted (2026-11-26)
- Related: ADR-0041 (catalog), ADR-0082 (no output schema), ADR-0099 (shell fallback)

## Decision

Tool descriptions are layered instead of applying one long template to all 22
tools:

- tools where selection is ambiguous or the effect is high-risk use a compact
  Tool Card: `Purpose`, `Use when`, `Do not use when`, `Returns`, `Errors`,
  `Security`;
- simple read/search/planning tools keep a one-paragraph description and their
  JSON Schema;
- no `Output Schema` is added. Every built-in tool returns text plus
  `completeness`, so a JSON output schema would describe a structure that does
  not exist (ADR-0082). The `Returns` line states the facts the adapter adds.
- `Errors` is one line of safe codes, not a full retry table. The runtime result
  already carries `status`, `safeCode` and `completeness` at the point of use.
- `Security` states approval, read-only status, external request or side effect
  without duplicating the runtime permission metadata.

The external AgentGuide ReAct page and its Tool Card template were used as a
reference for the fields, not as a requirement. That page does not define the
Harness shell fallback in ADR-0099.

## Consequences

The catalog's total description text grew from roughly 3.6k to 12.6k characters
because 14 high-risk or ambiguous tools now carry the six structured fields. This
is fixed context on every request; simple tools were deliberately left unchanged.

Descriptions can now say when not to use a tool, which is the failure the
external guide identifies as "wrong tool selection". Output shape remains
honest: text plus completeness, never a fabricated schema.

## Reassessment Conditions

Revisit if the fixed description cost needs measurement, if a provider starts
requiring structured output metadata, or if a simple tool begins to be selected
wrongly often enough to justify a card.
