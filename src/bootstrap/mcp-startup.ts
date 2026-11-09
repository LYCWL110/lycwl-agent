import type { spawn } from "node:child_process";
import { connectMcpServer, type McpConnection } from "../adapters/windows/mcp-connection.ts";
import {
  type McpServerDeclaration,
  type McpValidatedTool,
  validateMcpServers,
  validateMcpTools,
} from "../domain/mcp/mcp-server.ts";
import { filterChildEnvironment } from "../domain/process/shell.ts";
import type { ApprovalGate } from "../ports/approval-gate.ts";

/**
 * MCP server lifecycle for a Session.
 *
 * A server is a third-party process running with the current Windows user's
 * permissions and no sandbox. It may not spawn until the user has approved it by
 * name, command and argument list in this Session. Approval is not remembered across
 * launches: a server that could quietly start on every boot is a persistent
 * privilege, and the confirmed policy grants none.
 *
 * The environment passed to the process is the C09 final filter output. A server
 * declaration cannot reintroduce a filtered name, because the filter runs last.
 */

export type McpStartupFailure =
  | "declaration_invalid"
  | "approval_denied"
  | "spawn_failed"
  | "handshake_failed"
  | "timeout"
  | "closed"
  | "frame_too_large"
  | "invalid_frame"
  | "protocol_error"
  | "no_tools";

export type McpStartupResult =
  | Readonly<{
      ok: true;
      connections: readonly Readonly<{
        declaration: McpServerDeclaration;
        connection: McpConnection;
        tools: readonly Readonly<{
          name: string;
          namespaced: string;
          description: string;
          inputSchema: Readonly<Record<string, unknown>>;
        }>[];
      }>[];
      warnings: readonly string[];
    }>
  | Readonly<{ ok: false; code: McpStartupFailure; detail?: string }>;

export type StartMcpOptions = Readonly<{
  /** Raw `mcp.servers` value from user configuration. */
  declared: unknown;
  workspaceRoot: string;
  /** Approval for each server, one at a time. */
  approvals: ApprovalGate;
  /** Credential names the C09 filter removes; used for the pre-check. */
  providerCredentialNames?: readonly string[];
  /** Injected for tests. */
  spawnProcess?: typeof spawn;
  requestTimeoutMs?: number;
}>;

/**
 * Validate, approve and connect every declared server.
 *
 * One refused or broken server does not take down the Session: the remaining
 * servers still start and the failure is reported. A Session with no working
 * server simply has no MCP tools, which is the safe default.
 */
export async function startMcpServers(options: StartMcpOptions): Promise<McpStartupResult> {
  const parsed = validateMcpServers(options.declared);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "declaration_invalid",
      detail: parsed.detail === undefined ? parsed.code : `${parsed.code}:${parsed.detail}`,
    };
  }
  if (parsed.servers.length === 0) {
    return { ok: true, connections: [], warnings: [] };
  }

  const connections: {
    declaration: McpServerDeclaration;
    connection: McpConnection;
    tools: McpValidatedTool[];
  }[] = [];
  const warnings: string[] = [];
  let lastFailure: Readonly<{ code: McpStartupFailure; detail?: string }> | null = null;

  for (const declaration of parsed.servers) {
    const decision = await options.approvals.decide({
      approvalId: `mcp-start-${declaration.serverId}`,
      toolCallId: `mcp-start-${declaration.serverId}`,
      toolName: "mcp_server_start",
      safePreview: renderStartupPreview(declaration),
    });
    if (decision !== "approved") {
      lastFailure = { code: "approval_denied", detail: declaration.serverId };
      continue;
    }

    // Merge the host environment and the declared entries, then filter. The filter
    // is last, so a declaration naming a credential variable removes it rather than
    // reintroducing it.
    const filtered = filterChildEnvironment(
      readHostEnvironment(),
      declaration.environment,
      options.providerCredentialNames === undefined
        ? {}
        : { providerCredentialNames: options.providerCredentialNames },
    );
    if (filtered.missingGrantNames.length > 0) {
      // Nothing was granted, so this can only report an oddity. It is not fatal.
      warnings.push(`mcp ${declaration.serverId}: environment entry missing after filtering`);
    }

    const started = await connectMcpServer({
      serverId: declaration.serverId,
      command: declaration.command,
      args: declaration.args,
      environment: filtered.environment,
      cwd: options.workspaceRoot,
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    if (!started.ok) {
      lastFailure = {
        code: started.code === "spawn_failed" ? "spawn_failed" : started.code,
        detail: `${declaration.serverId}${started.detail === undefined ? "" : `: ${started.detail}`}`,
      };
      continue;
    }

    let tools: readonly McpValidatedTool[];
    try {
      const listed = await started.connection.listTools();
      const validated = validateMcpTools(
        declaration.serverId,
        listed.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      );
      if (!validated.ok) {
        await started.connection.close();
        lastFailure = { code: "no_tools", detail: `${declaration.serverId}: ${validated.code}` };
        continue;
      }
      tools = [...validated.tools];
    } catch {
      await started.connection.close();
      lastFailure = { code: "handshake_failed", detail: declaration.serverId };
      continue;
    }

    if (tools.length === 0) {
      // A server with no tools is a running process with no capability. Leaving it
      // alive would cost resources for nothing.
      await started.connection.close();
      lastFailure = { code: "no_tools", detail: declaration.serverId };
      continue;
    }

    connections.push({ declaration, connection: started.connection, tools: [...tools] });
  }

  if (connections.length === 0 && lastFailure !== null) {
    return {
      ok: false,
      code: lastFailure.code,
      ...(lastFailure.detail === undefined ? {} : { detail: lastFailure.detail }),
    };
  }
  if (lastFailure !== null) {
    warnings.push(
      `mcp: a server did not start (${lastFailure.code}${lastFailure.detail === undefined ? "" : `: ${lastFailure.detail}`})`,
    );
  }
  return { ok: true, connections, warnings };
}

/**
 * The approval preview.
 *
 * It shows the exact executable and argument vector, because that is what will run.
 * It also states the two facts a user needs to judge the risk: there is no sandbox,
 * and the process has the user's own permissions.
 */
export function renderStartupPreview(declaration: McpServerDeclaration): string {
  const environment = Object.keys(declaration.environment);
  return [
    "mcp_server_start",
    `server=${declaration.serverId}`,
    `executable=${declaration.command}`,
    `arguments=${declaration.args.length === 0 ? "(none)" : declaration.args.join(" ")}`,
    `workingDirectory=the Session workspace`,
    `environment=${environment.length === 0 ? "inherited environment after the C09 filter" : `filtered environment plus ${environment.join(",")}`}`,
    "sandbox=none",
    "permissions=current Windows user",
    "this starts a third-party program and keeps it running for the Session",
  ].join("\n");
}

/** The current process environment, which is the only source of inherited entries. */
function readHostEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
