# ADR-0077: MCP tool schema passthrough and active tool discovery

- Status: Accepted (2026-11-08)
- Related: ADR-0073 (MCP scope), ADR-0076 (formatter), V1_BASELINE.md section 6

## Context

The book *深入理解 AI Agent* chapter 4 (工具) sets out five principles for tool
design. Measuring the existing MCP implementation against them found two real
defects and one documentation gap.

| Principle | State before this ADR |
| --- | --- |
| ACI: design tools around the goal, not the API | Third-party tools are exposed as the server defines them; not ours to merge |
| Schema describes the parameters | **`inputSchema: {}`** — the server's schema was discarded |
| Do not load every tool into context | Every MCP tool was listed on every request |
| MCP and Skill compose | Both exist, unrelated |
| Security independent of the model | Namespacing, approval, C10 guard present |

The first two are defects. A tool advertised with an empty schema gives the model
no way to know its arguments, so the first call is a guess. And a project with
several servers pushes hundreds of schemas into every request, which costs tokens on
each round and makes the static prefix too large to stay cacheable.

## Decision

### Schema passthrough

The server's `inputSchema` is forwarded verbatim.

`normalizeInputSchema` substitutes `{ type: "object", properties: {} }` only when
the server sends something that is not an object. That substitution is honest — it
says "no arguments are declared" — whereas an empty object said nothing at all.
A schema missing `type` is treated as an object schema, which is what every tool
argument schema is.

Verified against `@modelcontextprotocol/server-filesystem`: the `read_text_file`
schema arrives with `$schema`, `properties.path`, `head` and `tail` intact.

### Active tool discovery

Above 24 MCP tools, the request carries only a compact server catalog and a
`discover_tools` tool. The model asks for the schemas of the few tools it wants.

- **Two-level match**, as the book describes: terms are matched against server id,
  tool name and description, with name matches weighted above description matches
  and server matches lowest, because every tool from a server shares that term.
- **Lexical, not semantic.** A semantic match needs an embedding model: a dependency
  and a privacy question this Harness has not answered. Lexical matching is weaker
  but explainable — every match reports *why* it matched, so a user can see the
  reasoning instead of trusting a number.
- **Deterministic order.** Ties break by name. A model that asks twice must not
  conclude the tool set changed.
- **Below the threshold, nothing changes.** Discovery adds a round trip; with a
  small tool set it costs more than it saves. 24 is where a full listing starts to
  dominate.
- **Discovery grants nothing.** It returns descriptions and schemas. A discovered
  tool still needs its own one-shot approval when called, so discovery cannot widen
  permission.
- **A failed query says what exists.** The empty result lists the connected servers
  and tells the model to retry with a real term, rather than only reporting that
  nothing matched.

The catalog enters the sourced project context, not the system prompt: it is
server-supplied text and must not acquire the authority of application rules.

### MCP and Skill compose

They already did: MCP provides stable typed capabilities, Skill documents a process
that combines them. `/skill` injects a body as untrusted project material; MCP tools
remain individually approved. No code change; this records the relationship.

## Consequences

- `domain/mcp/tool-discovery.ts` owns matching; `adapters/tools/discover-tools.ts`
  owns the tool; `domain/mcp/mcp-server.ts` owns schema normalization.
- `mcpToolDefinitions` carries `inputSchema` instead of dropping it.
- A new Harness tool, `discover_tools`, appears only when discovery is active.

## Known limitations

- **Lexical matching misses paraphrase.** "summarize this repository's contributors"
  finds `list_contributors`; "who contributed" may not. The failure mode is a
  retry, not a wrong call.
- **The threshold is a count, not a token budget.** Twenty tools with enormous
  schemas cost more than thirty small ones.
- **MCP Resources and Prompts are not implemented.** The book separates Tools,
  Resources and Prompts; this Harness implements Tools only. Resources would need
  a read path with its own approval model, and Prompts overlap with Skill.
- **Tool descriptions are truncated at 2048 characters**, so a server whose
  description carries instructions loses the tail. Truncation is preferred to an
  unbounded payload, but it is a loss.
- **No description-poisoning review.** A server controls its descriptions, and they
  reach model context as untrusted text. There is no automated check for injected
  instructions; the existing defence is that a description grants no authority and
  every call needs approval.

## Reassessment conditions

Reopen if lexical matching proves too weak in practice, if a token-budget threshold
is needed instead of a count, or if MCP Resources are added.
