# ADR-0082: Do not add `outputSchema` validation

- Status: Accepted (2026-11-08)
- Related: ADR-0080 (argument schema), ADR-0081 (result completeness), ADR-0079 (execution semantics)

## Context

The ACI review listed `outputSchema` as a remaining item: a JSON Schema for a tool's
output, checked against what the tool returned. Measuring the codebase before
implementing it found the premise does not hold.

Every built-in tool returns a single text string:

| Tool | Returns |
| --- | --- |
| `read_file` | numbered lines plus byte and hash facts |
| `grep` / `glob` / `list_dir` | matching paths or lines |
| `shell` | combined stdout and stderr |
| `todo` | a rendered list |
| `web_fetch` | fetched body text |
| `background_status` | a rendered task summary |
| MCP tools | whatever the server puts in its content array |

`ToolExecutionResult` has no `data` field, and the three provider adapters send tool
results as plain text. There is no structure to validate.

## Decision

`outputSchema` is not implemented.

The reasoning, in order of weight:

1. **It is not one of the four ACI principles.** SWE-agent's Section 2 states Simple,
   Compact & Efficient, Informative Feedback and Guardrails. `outputSchema` comes
   from a general-Harness extension in a secondary discussion, not from the paper
   this work is following.
2. **There is nothing to validate.** Adding the field would mean either validating
   that a text string parses as JSON — which most tools do not produce — or
   restructuring every tool to return structured data first.
3. **The measured evidence points the other way.** SWE-agent's ablation shows
   feedback *form* matters: showing a whole file scored 12.7% against 18.0% for a
   100-line window. Changing what the model receives from compact text to structured
   data is exactly the kind of change that experiment warns about, and it would be
   made without an equivalent measurement.
4. **The need is already met differently.** `completeness` (ADR-0081) says whether a
   result is whole. `evidence` carries byte counts and hashes for the tools that
   produce them. A schema would add a third way to describe the same facts.

## What would change this

The decision is about *this* result shape, not about the idea. It would be reopened
if:

- A tool needs to return machine-readable data the model must act on structurally
  rather than read — a paginated API result with a cursor, for instance.
- A consumer other than the model (a report, an integration) needs to parse tool
  output, which today only reads `text` and `completeness`.
- A measurement shows structured output improves task success on the target model,
  which is the same standard applied to every other ACI change here.

## Consequences

- No `data` field is added to `ToolExecutionResult`.
- No provider adapter changes how it serialises a tool result.
- The remaining ACI review items are closed as follows:

| Item | Status |
| --- | --- |
| Edit verification and revert | done (ADR-0078) |
| Retry semantics and outcome verification | done (ADR-0079) |
| Argument schema enforcement | done (ADR-0080) |
| Structured result completeness | done (ADR-0081) |
| `outputSchema` | **not done, this ADR** |
| Capability-based two-stage discovery | partially covered by MCP `discover_tools` (ADR-0077); built-in tools are 15 and need no discovery |
| `nextActions` | **not done**: the field exists only inside compaction summaries, where proposing tool calls is explicitly forbidden; a top-level version would let tool output steer the model's next call, which is the injection surface the Harness refuses elsewhere |
| Separate `agentSchema` / `executionPolicy` | **already satisfied, verified**: `runtime-selection.ts` builds each definition from `name`, `description` and `inputSchema` only, and the Anthropic adapter serialises exactly those three as `name`, `description` and `input_schema`. `sideEffectClass`, `requiresApproval`, `concurrencySafe`, `semantics` and `verification` never reach the model |

## Known limitations

- A future tool that genuinely returns structured data has no schema to declare it
  against. The cost of adding one then is the same as it is now; nothing is lost by
  waiting until a real case exists.
- This records a decision not to build, which is easier to revisit than an
  implementation is to remove.
