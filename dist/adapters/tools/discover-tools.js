import { DISCOVERY_LIMITS, discoverTools, renderServerCatalog, } from "../../domain/mcp/tool-discovery.js";
/**
 * The `discover_tools` tool.
 *
 * It is not an MCP tool: it is a Harness tool that lets the model ask which MCP
 * tools exist and receive the schemas for the few it wants. The schemas of every MCP
 * tool are not in the request; this is how the model obtains them.
 *
 * Two properties matter:
 *
 * - **It grants nothing.** Discovery returns descriptions and schemas. A discovered
 *   tool still needs its own approval when called, so discovery cannot be used to
 *   widen permission.
 * - **It is deterministic.** The same query returns the same list in the same order,
 *   so a model that asks twice does not conclude the tool set changed.
 *
 * The result is a tool result like any other, which means the ordinary output
 * handling applies: it can be spilled if a server's descriptions are enormous, and
 * the owned-key guard sees it.
 */
export const DISCOVER_TOOLS_NAME = "discover_tools";
/**
 * Description and schema for the discovery tool.
 *
 * The description tells the model when to use it, not just what it does: without
 * that, a model that already has a tool name in mind calls it directly and fails
 * because the schema was never loaded.
 */
export const DISCOVERY_TOOL_DESCRIPTION = "Find an MCP tool by describing what you need, and get its argument schema. " +
    "Call this before using any tool whose name starts with mcp__: those tools are " +
    "not listed in this request, so their schemas must be discovered first.";
export const DISCOVERY_TOOL_SCHEMA = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "What the tool should do, in a few words. Matched against tool names, " +
                "descriptions and server ids.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: DISCOVERY_LIMITS.maxResults,
            description: "Maximum tools to return. Defaults to the server limit.",
        },
    },
    required: ["query"],
    additionalProperties: false,
};
export function createDiscoverToolsTool(options) {
    const definition = {
        name: DISCOVER_TOOLS_NAME,
        version: "1",
        // Discovery reads a list the Harness already holds; it touches nothing external.
        sideEffectClass: "read_only",
        requiresApproval: false,
        concurrencySafe: true,
    };
    return {
        getDefinition(toolName) {
            return toolName === DISCOVER_TOOLS_NAME ? definition : null;
        },
        async preview() {
            return null;
        },
        async requiresApproval() {
            return false;
        },
        discardApproval() {
            // Nothing is reserved for this tool.
        },
        async execute(request) {
            const args = typeof request.arguments === "object" && request.arguments !== null
                ? request.arguments
                : {};
            const query = typeof args["query"] === "string" ? args["query"] : "";
            const limit = typeof args["limit"] === "number" &&
                Number.isSafeInteger(args["limit"]) &&
                args["limit"] > 0
                ? Math.min(args["limit"], DISCOVERY_LIMITS.maxResults)
                : DISCOVERY_LIMITS.maxResults;
            const all = options.tools();
            const result = discoverTools(all, query, limit);
            if (result.empty) {
                // Say what exists rather than only that nothing matched: the model can then
                // retry with a term drawn from the real scope instead of guessing again.
                const catalog = renderServerCatalog(all);
                return {
                    status: "succeeded",
                    text: catalog.length === 0
                        ? "No MCP tools are connected."
                        : `No tool matched "${query}".\nConnected servers:\n${catalog}\nRetry with a term from these names.`,
                };
            }
            return { status: "succeeded", text: renderMatches(result.matches, result.servers) };
        },
    };
}
/**
 * Render the matches with their schemas.
 *
 * The schema is included because that is the whole point of discovery: the model
 * needs the argument shape to make the call. It is compacted rather than
 * pretty-printed, since indentation is tokens spent on nothing.
 */
function renderMatches(matches, servers) {
    const lines = [
        `${matches.length} tool(s) matched. Call one by its namespaced name.`,
        `servers: ${servers.join(", ")}`,
        "",
    ];
    for (const match of matches) {
        lines.push(`### ${match.tool.name}`);
        lines.push(`why: ${match.reason}`);
        lines.push(`description: ${match.tool.description}`);
        lines.push(`schema: ${JSON.stringify(match.tool.inputSchema ?? {})}`);
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
