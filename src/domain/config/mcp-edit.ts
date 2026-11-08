import { findMember, parseJsonc, toPlainValue } from "./jsonc.ts";

/**
 * Localized editing of `mcp.servers` in the settings document (ADR-0073).
 *
 * The servers live in a nested array of objects, which the scalar-only editors in
 * `jsonc-edit.ts` cannot write. This module splices the `mcp` block's span directly
 * and leaves everything outside it untouched, so comments and formatting survive.
 *
 * Only add and remove are provided. Editing an existing entry is remove-then-add:
 * a server's identity is its id, and a rename is a different server, not an edit.
 */

export type McpEditFailure =
  | "invalid_document"
  | "root_not_object"
  | "invalid_mcp_block"
  | "duplicate_server_id"
  | "server_not_found"
  | "too_many_servers";

export type McpEditResult =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; code: McpEditFailure }>;

export type McpServerEntry = Readonly<{
  serverId: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}>;

export const MCP_EDIT_LIMITS = Object.freeze({
  maxServers: 16,
});

/** Read the current declarations, tolerating an absent or malformed block. */
export function readMcpServerEntries(text: string): readonly McpServerEntry[] {
  const parsed = parseJsonc(text);
  if (!parsed.ok || parsed.value.kind !== "object") return [];
  const mcp = findMember(parsed.value, "mcp");
  if (mcp === null || mcp.value.kind !== "object") return [];
  const servers = findMember(mcp.value, "servers");
  if (servers === null || servers.value.kind !== "array") return [];

  const entries: McpServerEntry[] = [];
  for (const item of servers.value.items) {
    if (item.kind !== "object") continue;
    const plain = toPlainValue(item);
    if (typeof plain !== "object" || plain === null) continue;
    const record = plain as Record<string, unknown>;
    const serverId = record["serverId"];
    const command = record["command"];
    if (typeof serverId !== "string" || typeof command !== "string") continue;
    const rawArgs = record["args"];
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((arg): arg is string => typeof arg === "string")
      : [];
    const rawEnvironment = record["environment"];
    const environment: Record<string, string> = {};
    if (typeof rawEnvironment === "object" && rawEnvironment !== null) {
      for (const [name, value] of Object.entries(rawEnvironment)) {
        if (typeof value === "string") environment[name] = value;
      }
    }
    entries.push({ serverId, command, args, environment });
  }
  return entries;
}

/**
 * Add a server.
 *
 * A duplicate id is refused rather than replaced: silently replacing a declaration
 * would change which executable runs under an id the user already approved.
 */
export function addMcpServer(text: string, entry: McpServerEntry): McpEditResult {
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, code: "invalid_document" };
  if (parsed.value.kind !== "object") return { ok: false, code: "root_not_object" };

  const existing = readMcpServerEntries(text);
  if (existing.some((server) => server.serverId === entry.serverId)) {
    return { ok: false, code: "duplicate_server_id" };
  }
  if (existing.length >= MCP_EDIT_LIMITS.maxServers) {
    return { ok: false, code: "too_many_servers" };
  }

  const literal = serializeServer(entry, detectIndent(text));
  const mcpMember = findMember(parsed.value, "mcp");

  if (mcpMember === null) {
    // No block at all: write one containing just this server.
    return insertTopLevelRaw(
      text,
      "mcp",
      `{\n${detectIndent(text)}  "servers": [\n${literal}\n${detectIndent(text)}  ]\n${detectIndent(text)}}`,
    );
  }
  if (mcpMember.value.kind !== "object") return { ok: false, code: "invalid_mcp_block" };

  const serversMember = findMember(mcpMember.value, "servers");
  if (serversMember === null) {
    // An `mcp` block without `servers`: add the array inside it.
    const blockText = text.slice(mcpMember.value.start, mcpMember.value.end);
    const edited = insertTopLevelRaw(
      blockText,
      "servers",
      `[\n${literal}\n${detectIndent(text)}  ]`,
    );
    if (!edited.ok) return edited;
    return {
      ok: true,
      text: `${text.slice(0, mcpMember.value.start)}${edited.text}${text.slice(mcpMember.value.end)}`,
    };
  }
  if (serversMember.value.kind !== "array") return { ok: false, code: "invalid_mcp_block" };

  // Splice the new element just before the closing bracket, adding a comma when
  // the array already has elements.
  const close = serversMember.value.end - 1;
  const before = text.slice(0, close);
  const trimmed = before.replace(/\s+$/, "");
  const needsComma = serversMember.value.items.length > 0;
  const separator = needsComma ? "," : "";
  const trailing = text.slice(trimmed.length, close);
  return {
    ok: true,
    text: `${trimmed}${separator}\n${literal}${trailing}${text.slice(close)}`,
  };
}

/** Remove a server by id, leaving the rest of the document untouched. */
export function removeMcpServer(text: string, serverId: string): McpEditResult {
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, code: "invalid_document" };
  if (parsed.value.kind !== "object") return { ok: false, code: "root_not_object" };

  const mcpMember = findMember(parsed.value, "mcp");
  if (mcpMember === null || mcpMember.value.kind !== "object") {
    return { ok: false, code: "server_not_found" };
  }
  const serversMember = findMember(mcpMember.value, "servers");
  if (serversMember === null || serversMember.value.kind !== "array") {
    return { ok: false, code: "server_not_found" };
  }

  let index = -1;
  for (let position = 0; position < serversMember.value.items.length; position += 1) {
    const item = serversMember.value.items[position];
    if (item === undefined || item.kind !== "object") continue;
    const plain = toPlainValue(item);
    if (
      typeof plain === "object" &&
      plain !== null &&
      (plain as Record<string, unknown>)["serverId"] === serverId
    ) {
      index = position;
      break;
    }
  }
  if (index === -1) return { ok: false, code: "server_not_found" };

  const item = serversMember.value.items[index];
  if (item === undefined) return { ok: false, code: "server_not_found" };

  // Remove the element and one adjacent comma, preferring the trailing one.
  const afterValue = skipWhitespace(text, item.end);
  if (text[afterValue] === ",") {
    return { ok: true, text: `${text.slice(0, item.start)}${text.slice(afterValue + 1)}` };
  }
  if (index > 0) {
    const previous = serversMember.value.items[index - 1];
    if (previous !== undefined) {
      const comma = lastCommaBetween(text, previous.end, item.start);
      if (comma !== -1) {
        return { ok: true, text: `${text.slice(0, comma)}${text.slice(item.end)}` };
      }
    }
  }
  return { ok: true, text: `${text.slice(0, item.start)}${text.slice(item.end)}` };
}

/** Render one server as a JSON object literal indented for its array. */
function serializeServer(entry: McpServerEntry, baseIndent: string): string {
  const inner = `${baseIndent}    `;
  const lines = [
    `"serverId": ${JSON.stringify(entry.serverId)}`,
    `"command": ${JSON.stringify(entry.command)}`,
    `"args": [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
  ];
  const environmentNames = Object.keys(entry.environment);
  if (environmentNames.length > 0) {
    const pairs = environmentNames
      .map(
        (name) =>
          `${inner}  ${JSON.stringify(name)}: ${JSON.stringify(entry.environment[name] ?? "")}`,
      )
      .join(",\n");
    lines.push(`"environment": {\n${pairs}\n${inner}}`);
  }
  return `${inner}{\n${inner}  ${lines.join(`,\n${inner}  `)}\n${inner}}`;
}

/** Insert a pre-serialized literal at the top level. */
function insertTopLevelRaw(text: string, key: string, literal: string): McpEditResult {
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, code: "invalid_document" };
  if (parsed.value.kind !== "object") return { ok: false, code: "root_not_object" };

  const root = parsed.value;
  const keyText = JSON.stringify(key);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";

  if (root.members.length === 0) {
    const open = root.start + 1;
    const close = root.end - 1;
    if (text.slice(open, close).trim().length === 0) {
      return {
        ok: true,
        text: `${text.slice(0, open)} ${keyText}: ${literal} ${text.slice(close)}`,
      };
    }
  }

  const last = root.members.at(-1);
  if (last === undefined) {
    const open = root.start + 1;
    return { ok: true, text: `${text.slice(0, open)} ${keyText}: ${literal},${text.slice(open)}` };
  }
  const indent = detectIndent(text);
  const insertAt = last.value.end;
  return {
    ok: true,
    text: `${text.slice(0, insertAt)},${newline}${indent}${keyText}: ${literal}${text.slice(insertAt)}`,
  };
}

function detectIndent(text: string): string {
  const match = /^([ \t]+)"/mu.exec(text.slice(text.indexOf("\n") + 1));
  return match?.[1] ?? "  ";
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  for (;;) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      index += 1;
      continue;
    }
    return index;
  }
}

function lastCommaBetween(text: string, from: number, to: number): number {
  for (let index = to - 1; index >= from; index -= 1) {
    if (text[index] === ",") return index;
  }
  return -1;
}
