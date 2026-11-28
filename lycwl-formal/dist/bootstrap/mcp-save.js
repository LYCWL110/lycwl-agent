import { parseJsonc, toPlainValue } from "../domain/config/jsonc.js";
import { addMcpServer, removeMcpServer } from "../domain/config/mcp-edit.js";
import { validateMcpServers } from "../domain/mcp/mcp-server.js";
export async function saveMcpChange(options) {
    const loaded = await options.store.load();
    if (!loaded.ok) {
        return {
            ok: false,
            code: loaded.code === "config_missing" ? "config_missing" : "config_unreadable",
        };
    }
    let text = loaded.value.text;
    if (options.remove !== undefined) {
        const removed = removeMcpServer(text, options.remove);
        if (!removed.ok) {
            return {
                ok: false,
                code: removed.code === "server_not_found" ? "server_not_found" : "invalid_document",
            };
        }
        text = removed.text;
    }
    if (options.add !== undefined) {
        const added = addMcpServer(text, options.add);
        if (!added.ok) {
            return {
                ok: false,
                code: added.code === "duplicate_server_id"
                    ? "duplicate_server_id"
                    : added.code === "too_many_servers"
                        ? "too_many_servers"
                        : "invalid_document",
            };
        }
        text = added.text;
    }
    // Validate the declaration list the document now contains. The editor produces
    // structurally valid JSON; this checks the semantics the launcher enforces.
    const parsed = parseJsonc(text);
    if (!parsed.ok)
        return { ok: false, code: "invalid_document" };
    const document = toPlainValue(parsed.value);
    const declared = typeof document === "object" && document !== null
        ? document["mcp"]
        : undefined;
    const servers = typeof declared === "object" && declared !== null
        ? declared["servers"]
        : undefined;
    const validated = validateMcpServers(servers);
    if (!validated.ok) {
        return {
            ok: false,
            code: "invalid_declaration",
            detail: validated.detail === undefined ? validated.code : `${validated.code}:${validated.detail}`,
        };
    }
    const saved = await options.store.save({
        baseRevision: loaded.value.revision,
        baseDocumentHash: loaded.value.documentHash,
        draft: text,
    });
    if (!saved.ok) {
        return {
            ok: false,
            code: saved.code === "config_conflict" ? "config_conflict" : "config_write_failed",
            detail: saved.code,
        };
    }
    return {
        ok: true,
        entries: validated.servers.map((server) => ({
            serverId: server.serverId,
            command: server.command,
            args: server.args,
            environment: server.environment,
        })),
    };
}
