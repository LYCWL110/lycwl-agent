import {
  type McpServerDeclaration,
  mcpToolName,
  parseMcpToolName,
  validateMcpTools,
} from "../../domain/mcp/mcp-server.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";
import type { McpConnection } from "../windows/mcp-connection.ts";

/**
 * MCP tools as ordinary Harness tools.
 *
 * Each server tool is exposed as `mcp__<server>__<tool>` and carries the same
 * side-effect class as an external request, so it always requires one-shot approval.
 * The Harness cannot know what an MCP tool does, so it must not assume anything:
 * declaring it read-only would be a privilege grant based on a server's own claim.
 *
 * A tool result is untrusted input. It is returned as text and passes the ordinary
 * C10 owned-key guard like any other tool output.
 */

export const MCP_SIDE_EFFECT_CLASS = "external_request" as const;

export type McpServerRuntime = Readonly<{
  declaration: McpServerDeclaration;
  connection: McpConnection;
  tools: readonly Readonly<{ name: string; namespaced: string; description: string }>[];
}>;

export type McpRegistryFailure =
  | "unknown_server"
  | "tool_not_found"
  | "invalid_arguments"
  | "server_rejected";

export type McpRegistryResult =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; code: McpRegistryFailure; detail?: string }>;

/**
 * Build a tool executor over a set of connected servers.
 *
 * Connections are supplied by the caller, which owns approval and spawning. This
 * layer only routes calls and normalizes results.
 */
export function createMcpTools(runtimes: readonly McpServerRuntime[]): ToolExecutor {
  const byName = new Map<
    string,
    Readonly<{ runtime: McpServerRuntime; toolName: string; definition: ToolDefinition }>
  >();

  for (const runtime of runtimes) {
    const validated = validateMcpTools(runtime.declaration.serverId, runtime.tools);
    if (!validated.ok) continue;
    for (const tool of validated.tools) {
      byName.set(tool.namespaced, {
        runtime,
        toolName: tool.name,
        definition: {
          name: tool.namespaced,
          version: "1",
          sideEffectClass: MCP_SIDE_EFFECT_CLASS,
          // An MCP tool can do anything the server can, so it is never approval-free.
          requiresApproval: true,
          concurrencySafe: false,
        },
      });
    }
  }

  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return byName.get(toolName)?.definition ?? null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      const entry = byName.get(request.toolName);
      if (entry === undefined) return null;
      const parsed = parseMcpToolName(request.toolName);
      if (!parsed.ok) return null;
      return [
        "mcp_tool",
        `server=${parsed.serverId}`,
        `tool=${parsed.toolName}`,
        `arguments=${summarizeArguments(request.arguments)}`,
        "effect=runs a third-party server tool with the current user's permissions",
        "sandbox=none; the Harness cannot verify what this tool does",
      ].join("\n");
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const entry = byName.get(request.toolName);
      if (entry === undefined) {
        return { status: "failed", safeCode: "unknown_tool", text: null };
      }

      const called = await entry.runtime.connection.callTool(entry.toolName, request.arguments);
      if (!called.ok) {
        // A timeout or a closed connection may mean the server acted anyway, so the
        // outcome is unknown rather than failed.
        return called.code === "timeout" || called.code === "closed"
          ? { status: "outcome_unknown", safeCode: `mcp_${called.code}` }
          : { status: "failed", safeCode: `mcp_${called.code}`, text: null };
      }

      // A server-reported error is a tool failure, not a Harness failure.
      if (called.isError) {
        return { status: "failed", safeCode: "mcp_tool_reported_error", text: called.text };
      }
      return { status: "succeeded", text: called.text };
    },

    /**
     * Close every server. A Session end must not leave third-party processes
     * running; a failure to close one is reported rather than swallowed.
     */
    async cancelAll(): Promise<void> {
      const results = await Promise.allSettled(
        runtimes.map((runtime) => runtime.connection.close()),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("mcp_cleanup_failed");
      }
    },
  };
}

/** Namespaced definitions for a set of runtimes, for the model-facing catalog. */
export function mcpToolDefinitions(
  runtimes: readonly McpServerRuntime[],
): readonly Readonly<{ name: string; description: string }>[] {
  const definitions: { name: string; description: string }[] = [];
  for (const runtime of runtimes) {
    const validated = validateMcpTools(runtime.declaration.serverId, runtime.tools);
    if (!validated.ok) continue;
    for (const tool of validated.tools) {
      definitions.push({ name: tool.namespaced, description: tool.description });
    }
  }
  return definitions;
}

/**
 * Argument summary for the approval preview.
 *
 * Values are shown because the user is approving this exact call; the C10 guard
 * still applies to what reaches the model, and a credential in an argument is the
 * server's problem, not something this preview can silently hide.
 */
function summarizeArguments(args: unknown): string {
  if (args === undefined || args === null) return "(none)";
  try {
    const text = JSON.stringify(args);
    return text.length <= 400 ? text : `${text.slice(0, 400)}...`;
  } catch {
    return "(unserializable)";
  }
}

export { mcpToolName };
