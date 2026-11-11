# ADR-0080: Enforce the advertised tool schema on the reply

- Status: Accepted (2026-11-08)
- Related: ADR-0077 (MCP schema), ADR-0079 (execution semantics), V1_BASELINE.md section 6

## Context

Every built-in tool has a JSON Schema in `domain/tool-catalog/tool-catalog.ts`, and
that schema is sent to the model on every request. It was never used to check what
came back. Each adapter re-implemented the same `typeof x !== "string"` checks by
hand: about 77 of them across ten files.

Two consequences, both real:

- **The advertised contract and the enforced one could disagree.** A schema saying
  `minimum: 1` with a hand-written check that forgot it means the model is told one
  thing and held to another.
- **An invalid call reached the approval prompt.** The model was asked to confirm an
  operation that could not succeed, and the adapter rejected it afterwards. The user
  approved something that never ran.

## Decision

The coordinator validates a tool call against its advertised schema before anything
else: before the no-progress check, before approval, before execution.

### Not a general JSON Schema implementation

`domain/tool-invocation/argument-validation.ts` supports `type`, `enum`, `minimum`,
`maximum`, `minLength`, `maxLength`, `pattern`, `items`, `required`, `properties` and
`additionalProperties` — exactly what the catalog uses. `checkSchemaSupport` refuses
any other keyword, and the composition root runs it over the whole catalog at
startup.

That refusal is the point. A validator that silently skipped an unsupported keyword
would report a value as valid when the constraint was never applied, which is worse
than not validating: it converts an unimplemented check into a false assurance.
Failing at startup means an unsupported schema cannot ship.

No dependency was added. `ajv` would be a large surface for eleven keywords, and its
error messages would have to be reshaped for the model anyway.

### The schema is the same object the model receives

`argumentSchemas` is built from the catalog entries already used to build the
request, so the two cannot drift. A separate copy would be a second source of truth.

### MCP tools are not validated here

Their schema comes from the server and is forwarded verbatim (ADR-0077). Validating
it would mean trusting a third party's schema to describe its own arguments
correctly; the server validates its own input, and a Harness-side check that
disagreed would reject calls the server would accept.

### A rejection is a model error, not a Harness failure

The tool result is `failed` with `invalid_arguments`, the issues are listed with
their paths, and the text states that nothing was executed. Siblings stop: if one
call in a batch is malformed, the rest of that batch came from the same response and
deserves the same suspicion.

Values are never echoed. A string argument is described as `string(123)`, because the
value may be a credential the user pasted and the error goes into model context.

## Consequences

- `tool_arguments_rejected` records the event with the tool name and issue count.
- `ToolDefinition`-shaped hand-written checks remain in the adapters. They are now a
  second line of defence rather than the only one; removing them is a separate change
  with its own risk, because some encode rules a schema cannot express (path
  containment, file existence).
- Startup fails if any catalog schema uses an unsupported keyword.

## Known limitations

- **Eleven keywords.** A future tool needing `oneOf`, `allOf`, `$ref` or `format`
  will fail the startup check rather than being silently unvalidated. That is
  intentional but it is a real limit.
- **The adapters still validate by hand.** The schema check does not replace them,
  so a rule that exists only in code and not in the schema is still enforced twice
  and documented once.
- **No coercion.** A string `"5"` where an integer is required is rejected, not
  converted. Coercion would make the enforced contract differ from the advertised
  one.
- **MCP arguments are unchecked**, as above.

## Reassessment conditions

Reopen if a tool needs a schema keyword outside the eleven, if the hand-written
checks are found to disagree with the schemas, or if MCP servers are observed
accepting malformed input they should have rejected.
