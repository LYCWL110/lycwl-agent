/**
 * MCP stdio server declarations (ADR-0068).
 *
 * Scope is deliberately narrow. Servers come from **user configuration only**:
 * never discovered on disk, never added by a project file, never fetched. The
 * transport is stdio only. A server must be approved at launch before it may spawn,
 * and every tool it exposes is namespaced and still needs its own approval.
 *
 * This module is pure: it validates declarations and derives tool names. It does not
 * spawn, connect or read anything.
 */

export const MCP_LIMITS = Object.freeze({
  maxServers: 16,
  maxArgs: 32,
  maxArgLength: 4_096,
  maxCommandLength: 1_024,
  maxToolNameLength: 128,
  maxToolDescriptionLength: 2_048,
  /** A single JSON-RPC frame is bounded, matching the reference implementations. */
  maxFrameBytes: 16 * 1024 * 1024,
  /** Grace period before the process group is killed. */
  shutdownGraceMs: 2_000,
});

/** Tool-name namespace prefix. Chosen so a name cannot collide with a built-in. */
export const MCP_TOOL_PREFIX = "mcp__";

export type McpServerFailure =
  | "invalid_server_id"
  | "invalid_command"
  | "invalid_args"
  | "too_many_servers"
  | "duplicate_server_id"
  | "invalid_environment_name"
  | "reserved_tool_name";

export type McpServerDeclaration = Readonly<{
  /** Stable id; also the tool-name namespace component. */
  serverId: string;
  command: string;
  args: readonly string[];
  /**
   * Extra environment entries declared for this server. The host environment is
   * filtered by C09 and merged before launch; these are overlaid on top and then
   * filtered again, so a declaration cannot reintroduce a filtered name.
   */
  environment: Readonly<Record<string, string>>;
}>;

export type McpDeclarationResult =
  | Readonly<{ ok: true; servers: readonly McpServerDeclaration[] }>
  | Readonly<{ ok: false; code: McpServerFailure; detail?: string }>;

const SERVER_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Validate a list of declarations.
 *
 * A server id must be a lowercase hyphenated token: it becomes part of a tool name,
 * and a name containing characters that a tool schema cannot carry would produce a
 * tool the model can never call.
 */
export function validateMcpServers(input: unknown): McpDeclarationResult {
  if (input === undefined) return { ok: true, servers: [] };
  if (!Array.isArray(input)) return { ok: false, code: "invalid_server_id" };
  if (input.length > MCP_LIMITS.maxServers) return { ok: false, code: "too_many_servers" };

  const seen = new Set<string>();
  const servers: McpServerDeclaration[] = [];

  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, code: "invalid_server_id" };
    }
    const record = entry as Record<string, unknown>;

    const serverId = record["serverId"];
    if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) {
      return { ok: false, code: "invalid_server_id", detail: String(serverId) };
    }
    if (seen.has(serverId)) {
      return { ok: false, code: "duplicate_server_id", detail: serverId };
    }
    seen.add(serverId);

    const command = record["command"];
    if (
      typeof command !== "string" ||
      command.trim().length === 0 ||
      command.length > MCP_LIMITS.maxCommandLength
    ) {
      return { ok: false, code: "invalid_command", detail: serverId };
    }
    // A command is an executable path, not a shell line. A declaration that contains
    // shell metacharacters would be executed by cmd.exe and could run arbitrary
    // commands, so it is refused rather than escaped.
    if (/[&|<>^%\r\n]/u.test(command)) {
      return { ok: false, code: "invalid_command", detail: serverId };
    }

    const rawArgs = record["args"];
    const args: string[] = [];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs) || rawArgs.length > MCP_LIMITS.maxArgs) {
        return { ok: false, code: "invalid_args", detail: serverId };
      }
      for (const arg of rawArgs) {
        if (typeof arg !== "string" || arg.length > MCP_LIMITS.maxArgLength) {
          return { ok: false, code: "invalid_args", detail: serverId };
        }
        if (arg.includes("\u0000")) return { ok: false, code: "invalid_args", detail: serverId };
        args.push(arg);
      }
    }

    const rawEnvironment = record["environment"];
    const environment: Record<string, string> = {};
    if (rawEnvironment !== undefined) {
      if (typeof rawEnvironment !== "object" || rawEnvironment === null) {
        return { ok: false, code: "invalid_environment_name", detail: serverId };
      }
      for (const [name, value] of Object.entries(rawEnvironment as Record<string, unknown>)) {
        if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
          return { ok: false, code: "invalid_environment_name", detail: name };
        }
        if (typeof value !== "string") {
          return { ok: false, code: "invalid_environment_name", detail: name };
        }
        environment[name] = value;
      }
    }

    servers.push({ serverId, command, args, environment });
  }

  return { ok: true, servers };
}

/**
 * Namespaced tool name for an MCP tool.
 *
 * The prefix makes a collision with a built-in impossible by construction rather
 * than by convention, which matters because a shadowed `shell` would be a silent
 * privilege change.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

export type McpToolNameParse =
  | Readonly<{ ok: true; serverId: string; toolName: string }>
  | Readonly<{ ok: false; code: "not_an_mcp_tool" | "malformed_tool_name" }>;

export function parseMcpToolName(name: string): McpToolNameParse {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return { ok: false, code: "not_an_mcp_tool" };
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return { ok: false, code: "malformed_tool_name" };
  const serverId = rest.slice(0, separator);
  const toolName = rest.slice(separator + 2);
  if (serverId.length === 0 || toolName.length === 0) {
    return { ok: false, code: "malformed_tool_name" };
  }
  return { ok: true, serverId, toolName };
}

/** A tool description an MCP server advertised. */
export type McpToolDescriptor = Readonly<{
  name: string;
  description: string;
}>;

export type McpToolValidation =
  | Readonly<{
      ok: true;
      tools: readonly Readonly<{ name: string; namespaced: string; description: string }>[];
    }>
  | Readonly<{ ok: false; code: McpServerFailure; detail?: string }>;

/**
 * Validate the tool list a server returned.
 *
 * A server controls these strings, so they are untrusted input. A name that cannot
 * be represented in a tool schema, or one that would produce a reserved name, is
 * refused rather than renamed: silently renaming would leave the model calling a
 * tool the server does not have.
 */
export function validateMcpTools(
  serverId: string,
  tools: readonly McpToolDescriptor[],
): McpToolValidation {
  const seen = new Set<string>();
  const validated: { name: string; namespaced: string; description: string }[] = [];

  for (const tool of tools) {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      return { ok: false, code: "reserved_tool_name", detail: serverId };
    }
    const namespaced = mcpToolName(serverId, tool.name);
    if (namespaced.length > MCP_LIMITS.maxToolNameLength) {
      return { ok: false, code: "reserved_tool_name", detail: tool.name };
    }
    if (seen.has(namespaced)) {
      return { ok: false, code: "duplicate_server_id", detail: namespaced };
    }
    seen.add(namespaced);

    const description =
      typeof tool.description === "string"
        ? tool.description.slice(0, MCP_LIMITS.maxToolDescriptionLength)
        : "";
    validated.push({ name: tool.name, namespaced, description });
  }

  return { ok: true, tools: validated };
}

/**
 * Whether a declared environment name would survive the C09 final filter.
 *
 * This is a pre-check for a clear error. The filter itself runs at launch and is the
 * authority; a name refused here would also be refused there.
 */
export function environmentNameIsFiltered(name: string, filteredNames: readonly string[]): boolean {
  const upper = name.toUpperCase();
  const base = upper.startsWith("INPUT_") ? upper.slice("INPUT_".length) : upper;
  return filteredNames.some((entry) => {
    const filtered = entry.toUpperCase();
    return filtered === upper || filtered === base;
  });
}
