import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import {
  addMcpServer,
  MCP_EDIT_LIMITS,
  readMcpServerEntries,
  removeMcpServer,
} from "../../src/domain/config/mcp-edit.ts";

/**
 * The MCP block is edited in place so a comment beside `provider` survives.
 * These tests assert the round trip through the real parser, not string equality.
 */

const BASE = `{
  "revision": 3,
  // keep this comment
  "provider": {
    "protocol": "openai_responses",
    "model": "m"
  }
}
`;

function read(text: string): unknown {
  const parsed = parseJsonc(text);
  assert.equal(parsed.ok, true);
  return parsed.ok ? toPlainValue(parsed.value) : null;
}

describe("addMcpServer", () => {
  it("creates the mcp block when it is absent", () => {
    const added = addMcpServer(BASE, {
      serverId: "files",
      command: "npx",
      args: [],
      environment: {},
    });
    assert.equal(added.ok, true);
    const document = read(added.ok ? added.text : "") as Record<string, unknown>;
    // An empty environment is omitted rather than written as `{}`: it carries no
    // information and would be noise in a hand-edited document.
    assert.deepEqual(document["mcp"], {
      servers: [{ serverId: "files", command: "npx", args: [] }],
    });
  });

  it("preserves an unrelated comment", () => {
    const added = addMcpServer(BASE, {
      serverId: "files",
      command: "npx",
      args: [],
      environment: {},
    });
    assert.match(added.ok ? added.text : "", /keep this comment/u);
  });

  it("appends to an existing array", () => {
    const once = addMcpServer(BASE, { serverId: "a", command: "one", args: [], environment: {} });
    assert.equal(once.ok, true);
    const twice = addMcpServer(once.ok ? once.text : "", {
      serverId: "b",
      command: "two",
      args: ["--x"],
      environment: {},
    });
    assert.equal(twice.ok, true);
    assert.deepEqual(readMcpServerEntries(twice.ok ? twice.text : ""), [
      { serverId: "a", command: "one", args: [], environment: {} },
      { serverId: "b", command: "two", args: ["--x"], environment: {} },
    ]);
  });

  it("writes args and environment as real values, not escaped strings", () => {
    const added = addMcpServer(BASE, {
      serverId: "files",
      command: "npx",
      args: ["-y", "@scope/server"],
      environment: { TOKEN_NAME: "value" },
    });
    assert.equal(added.ok, true);
    const document = read(added.ok ? added.text : "") as {
      mcp: { servers: { args: unknown; environment: unknown }[] };
    };
    const server = document.mcp.servers[0];
    assert.deepEqual(server?.args, ["-y", "@scope/server"]);
    assert.deepEqual(server?.environment, { TOKEN_NAME: "value" });
  });

  it("refuses a duplicate server id", () => {
    const once = addMcpServer(BASE, { serverId: "a", command: "one", args: [], environment: {} });
    const twice = addMcpServer(once.ok ? once.text : "", {
      serverId: "a",
      command: "other",
      args: [],
      environment: {},
    });
    assert.equal(twice.ok, false);
    assert.equal(twice.ok ? null : twice.code, "duplicate_server_id");
  });

  it("refuses beyond the server limit", () => {
    let text = BASE;
    for (let index = 0; index < MCP_EDIT_LIMITS.maxServers; index += 1) {
      const added = addMcpServer(text, {
        serverId: `s-${index}`,
        command: "cmd",
        args: [],
        environment: {},
      });
      assert.equal(added.ok, true);
      text = added.ok ? added.text : text;
    }
    const overflow = addMcpServer(text, {
      serverId: "one-too-many",
      command: "cmd",
      args: [],
      environment: {},
    });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.ok ? null : overflow.code, "too_many_servers");
  });

  it("adds servers to an mcp block that has no servers key", () => {
    const withBlock = `{\n  "mcp": {}\n}\n`;
    const added = addMcpServer(withBlock, {
      serverId: "files",
      command: "npx",
      args: [],
      environment: {},
    });
    assert.equal(added.ok, true);
    assert.deepEqual(readMcpServerEntries(added.ok ? added.text : ""), [
      { serverId: "files", command: "npx", args: [], environment: {} },
    ]);
  });
});

describe("removeMcpServer", () => {
  it("removes the requested server and keeps the others", () => {
    const first = addMcpServer(BASE, { serverId: "a", command: "one", args: [], environment: {} });
    const second = addMcpServer(first.ok ? first.text : "", {
      serverId: "b",
      command: "two",
      args: [],
      environment: {},
    });
    const removed = removeMcpServer(second.ok ? second.text : "", "a");
    assert.equal(removed.ok, true);
    assert.deepEqual(readMcpServerEntries(removed.ok ? removed.text : ""), [
      { serverId: "b", command: "two", args: [], environment: {} },
    ]);
  });

  it("removes the last element without leaving a dangling comma", () => {
    const added = addMcpServer(BASE, { serverId: "a", command: "one", args: [], environment: {} });
    const removed = removeMcpServer(added.ok ? added.text : "", "a");
    assert.equal(removed.ok, true);
    // The document must still parse; a trailing comma would be tolerated but a
    // dangling separator after the only element would not.
    const document = read(removed.ok ? removed.text : "") as Record<string, unknown>;
    assert.deepEqual(document["mcp"], { servers: [] });
  });

  it("reports an unknown server", () => {
    const removed = removeMcpServer(BASE, "absent");
    assert.equal(removed.ok, false);
    assert.equal(removed.ok ? null : removed.code, "server_not_found");
  });

  it("reports an absent mcp block", () => {
    const removed = removeMcpServer(BASE, "a");
    assert.equal(removed.ok, false);
    assert.equal(removed.ok ? null : removed.code, "server_not_found");
  });
});

describe("readMcpServerEntries", () => {
  it("returns an empty list for a document without the block", () => {
    assert.deepEqual(readMcpServerEntries(BASE), []);
  });

  it("skips a malformed entry rather than failing the whole read", () => {
    const text = `{\n  "mcp": { "servers": [ { "command": "no-id" }, { "serverId": "ok", "command": "c" } ] }\n}\n`;
    assert.deepEqual(readMcpServerEntries(text), [
      { serverId: "ok", command: "c", args: [], environment: {} },
    ]);
  });

  it("returns an empty list for an unparsable document", () => {
    assert.deepEqual(readMcpServerEntries("{ not json"), []);
  });
});
