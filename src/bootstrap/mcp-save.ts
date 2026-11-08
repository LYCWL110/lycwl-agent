import type { ConfigStore } from "../adapters/windows/config-store.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { addMcpServer, type McpServerEntry, removeMcpServer } from "../domain/config/mcp-edit.ts";
import { validateMcpServers } from "../domain/mcp/mcp-server.ts";

/**
 * Persist an MCP server change (ADR-0073).
 *
 * The write goes through the ordinary config store, so it takes the same lock and
 * the same revision/hash conflict check as a provider save. A stale draft is
 * reported as a conflict rather than overwriting an external edit.
 *
 * The edited document is validated against the MCP declaration rules *before* it is
 * saved. Writing a server that would be refused at launch would leave a
 * configuration that looks complete and silently does nothing.
 */

export type McpSaveFailure =
  | "config_missing"
  | "config_unreadable"
  | "config_conflict"
  | "config_write_failed"
  | "invalid_declaration"
  | "duplicate_server_id"
  | "server_not_found"
  | "too_many_servers"
  | "invalid_document";

export type McpSaveResult =
  | Readonly<{ ok: true; entries: readonly McpServerEntry[] }>
  | Readonly<{ ok: false; code: McpSaveFailure; detail?: string }>;

export type SaveMcpOptions = Readonly<{
  store: ConfigStore;
  add?: McpServerEntry;
  remove?: string;
}>;

export async function saveMcpChange(options: SaveMcpOptions): Promise<McpSaveResult> {
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
        code:
          added.code === "duplicate_server_id"
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
  if (!parsed.ok) return { ok: false, code: "invalid_document" };
  const document = toPlainValue(parsed.value);
  const declared =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)["mcp"]
      : undefined;
  const servers =
    typeof declared === "object" && declared !== null
      ? (declared as Record<string, unknown>)["servers"]
      : undefined;
  const validated = validateMcpServers(servers);
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid_declaration",
      detail:
        validated.detail === undefined ? validated.code : `${validated.code}:${validated.detail}`,
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
