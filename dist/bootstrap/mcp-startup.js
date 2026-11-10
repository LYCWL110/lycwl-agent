import { connectMcpServer } from "../adapters/windows/mcp-connection.js";
import { validateMcpServers, validateMcpTools, } from "../domain/mcp/mcp-server.js";
import { filterChildEnvironment } from "../domain/process/shell.js";
/**
 * Validate, approve and connect every declared server.
 *
 * One refused or broken server does not take down the Session: the remaining
 * servers still start and the failure is reported. A Session with no working
 * server simply has no MCP tools, which is the safe default.
 */
export async function startMcpServers(options) {
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
    const connections = [];
    const warnings = [];
    let lastFailure = null;
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
        const filtered = filterChildEnvironment(readHostEnvironment(), declaration.environment, options.providerCredentialNames === undefined
            ? {}
            : { providerCredentialNames: options.providerCredentialNames });
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
        let tools;
        try {
            const listed = await started.connection.listTools();
            const validated = validateMcpTools(declaration.serverId, listed.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            })));
            if (!validated.ok) {
                await started.connection.close();
                lastFailure = { code: "no_tools", detail: `${declaration.serverId}: ${validated.code}` };
                continue;
            }
            tools = [...validated.tools];
        }
        catch {
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
        warnings.push(`mcp: a server did not start (${lastFailure.code}${lastFailure.detail === undefined ? "" : `: ${lastFailure.detail}`})`);
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
export function renderStartupPreview(declaration) {
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
function readHostEnvironment() {
    const environment = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined)
            environment[name] = value;
    }
    return environment;
}
