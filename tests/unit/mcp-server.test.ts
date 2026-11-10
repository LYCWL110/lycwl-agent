import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  environmentNameIsFiltered,
  MCP_LIMITS,
  MCP_TOOL_PREFIX,
  mcpToolName,
  parseMcpToolName,
  validateMcpServers,
  validateMcpTools,
} from "../../src/domain/mcp/mcp-server.ts";

/**
 * MCP declarations are user input and MCP tool names are third-party input.
 * Both are validated here rather than at the call site.
 */

describe("validateMcpServers", () => {
  it("accepts an absent declaration as an empty list", () => {
    assert.deepEqual(validateMcpServers(undefined), { ok: true, servers: [] });
  });

  it("accepts a minimal server", () => {
    const result = validateMcpServers([{ serverId: "files", command: "npx" }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.servers : null, [
      { serverId: "files", command: "npx", args: [], environment: {} },
    ]);
  });

  it("rejects an uppercase or underscored server id", () => {
    // The id becomes part of a tool name; anything outside a lowercase token would
    // produce a name a tool schema cannot carry.
    for (const serverId of ["Files", "my_server", "my server", "", "-lead"]) {
      const result = validateMcpServers([{ serverId, command: "npx" }]);
      assert.equal(result.ok, false, serverId);
    }
  });

  it("rejects a duplicate server id", () => {
    const result = validateMcpServers([
      { serverId: "files", command: "a" },
      { serverId: "files", command: "b" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "duplicate_server_id");
  });

  it("rejects a command containing shell metacharacters", () => {
    // The command is an executable path, not a shell line. Accepting `&` would let a
    // declaration run a second command.
    for (const command of ["npx & calc", "a|b", "a>b", "a^b", "%PATH%"]) {
      const result = validateMcpServers([{ serverId: "files", command }]);
      assert.equal(result.ok, false, command);
      assert.equal(result.ok ? null : result.code, "invalid_command");
    }
  });

  it("rejects a NUL byte in an argument", () => {
    const result = validateMcpServers([{ serverId: "files", command: "npx", args: ["a\u0000b"] }]);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "invalid_args");
  });

  it("rejects too many servers", () => {
    const many = Array.from({ length: MCP_LIMITS.maxServers + 1 }, (_, index) => ({
      serverId: `server-${index}`,
      command: "npx",
    }));
    const result = validateMcpServers(many);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "too_many_servers");
  });

  it("rejects an environment name that is not an identifier", () => {
    const result = validateMcpServers([
      { serverId: "files", command: "npx", environment: { "BAD-NAME": "x" } },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "invalid_environment_name");
  });
});

describe("mcpToolName", () => {
  it("prefixes the server and the tool", () => {
    assert.equal(mcpToolName("files", "read"), "mcp__files__read");
    assert.equal(mcpToolName("files", "read").startsWith(MCP_TOOL_PREFIX), true);
  });

  it("round-trips through the parser", () => {
    const parsed = parseMcpToolName(mcpToolName("files", "read"));
    assert.deepEqual(parsed, { ok: true, serverId: "files", toolName: "read" });
  });

  it("keeps a tool name that itself contains the separator", () => {
    const parsed = parseMcpToolName("mcp__files__a__b");
    assert.deepEqual(parsed, { ok: true, serverId: "files", toolName: "a__b" });
  });

  it("rejects a built-in name and a malformed one", () => {
    assert.deepEqual(parseMcpToolName("read_file"), { ok: false, code: "not_an_mcp_tool" });
    assert.deepEqual(parseMcpToolName("mcp__files"), { ok: false, code: "malformed_tool_name" });
    assert.deepEqual(parseMcpToolName("mcp____read"), { ok: false, code: "malformed_tool_name" });
  });
});

describe("validateMcpTools", () => {
  it("namespaces every advertised tool", () => {
    const result = validateMcpTools("files", [
      { name: "read", description: "read a file" },
      { name: "write", description: "write a file" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.tools.map((tool) => tool.namespaced) : null, [
      "mcp__files__read",
      "mcp__files__write",
    ]);
  });

  it("rejects an empty tool name", () => {
    const result = validateMcpTools("files", [{ name: "", description: "x" }]);
    assert.equal(result.ok, false);
  });

  it("rejects a duplicate namespaced name", () => {
    const result = validateMcpTools("files", [
      { name: "read", description: "a" },
      { name: "read", description: "b" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "duplicate_server_id");
  });

  it("truncates an over-long description instead of failing", () => {
    // A long description is noise, not a reason to lose the tool.
    const result = validateMcpTools("files", [
      { name: "read", description: "x".repeat(MCP_LIMITS.maxToolDescriptionLength + 100) },
    ]);
    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.tools[0]?.description.length : -1,
      MCP_LIMITS.maxToolDescriptionLength,
    );
  });

  it("rejects a name that would exceed the tool-name limit", () => {
    const result = validateMcpTools("files", [{ name: "x".repeat(200), description: "" }]);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "reserved_tool_name");
  });
});

describe("environmentNameIsFiltered", () => {
  it("matches a filtered name case-insensitively", () => {
    assert.equal(environmentNameIsFiltered("github_token", ["GITHUB_TOKEN"]), true);
  });

  it("matches the INPUT_ counterpart", () => {
    assert.equal(environmentNameIsFiltered("INPUT_GITHUB_TOKEN", ["GITHUB_TOKEN"]), true);
  });

  it("does not match an unrelated name", () => {
    assert.equal(environmentNameIsFiltered("PATH", ["GITHUB_TOKEN"]), false);
  });
});
