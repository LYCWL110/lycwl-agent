import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDiscoverToolsTool,
  DISCOVER_TOOLS_NAME,
} from "../../src/adapters/tools/discover-tools.ts";
import type { DiscoverableTool } from "../../src/domain/mcp/tool-discovery.ts";

/**
 * The `discover_tools` tool.
 *
 * Two properties matter beyond matching: it grants no authority, and its failure
 * output is actionable rather than merely negative.
 */

function tool(serverId: string, toolName: string, description = ""): DiscoverableTool {
  return {
    name: `mcp__${serverId}__${toolName}`,
    serverId,
    toolName,
    description,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
}

const TOOLS: readonly DiscoverableTool[] = [
  tool("files", "read_text_file", "read a file as text"),
  tool("files", "write_file", "write a file"),
  tool("github", "list_contributors", "list repository contributors"),
];

function executor(tools: readonly DiscoverableTool[] = TOOLS) {
  return createDiscoverToolsTool({ tools: () => tools });
}

const call = async (args: unknown) =>
  executor().execute({ toolCallId: "c1", toolName: DISCOVER_TOOLS_NAME, arguments: args });

describe("discover_tools definition", () => {
  it("is read-only and needs no approval", async () => {
    // It reads a list the Harness already holds. A discovered tool still needs its
    // own approval, so discovery cannot widen permission.
    const definition = executor().getDefinition(DISCOVER_TOOLS_NAME);
    assert.equal(definition?.sideEffectClass, "read_only");
    assert.equal(definition?.requiresApproval, false);
  });

  it("has no definition under any other name", () => {
    assert.equal(executor().getDefinition("read_file"), null);
  });
});

describe("discover_tools execution", () => {
  it("returns matching tools with their schemas", async () => {
    const result = await call({ query: "contributors" });
    assert.equal(result.status, "succeeded");
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    assert.match(text, /mcp__github__list_contributors/);
    // The schema is the point of discovery: without it the call is a guess.
    assert.match(text, /schema:/);
    assert.match(text, /"path"/);
  });

  it("explains why each tool matched", async () => {
    const result = await call({ query: "read" });
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    assert.match(text, /why:/);
  });

  it("lists the connected servers so a retry can use a real term", async () => {
    const result = await call({ query: "blockchain" });
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    assert.match(text, /No tool matched/);
    assert.match(text, /files: 2 tool/);
    assert.match(text, /github: 1 tool/);
    assert.match(text, /Retry with a term/);
  });

  it("says plainly when no server is connected", async () => {
    const result = await executor([]).execute({
      toolCallId: "c1",
      toolName: DISCOVER_TOOLS_NAME,
      arguments: { query: "anything" },
    });
    assert.equal(result.status === "succeeded" ? result.text : "", "No MCP tools are connected.");
  });

  it("respects an explicit limit", async () => {
    const many = Array.from({ length: 10 }, (_unused, index) => tool("bulk", `read_${index}`));
    const result = await executor(many).execute({
      toolCallId: "c1",
      toolName: DISCOVER_TOOLS_NAME,
      arguments: { query: "read", limit: 2 },
    });
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    assert.match(text, /^2 tool\(s\) matched/);
  });

  it("caps a limit above the maximum rather than honoring it", async () => {
    const many = Array.from({ length: 20 }, (_unused, index) => tool("bulk", `read_${index}`));
    const result = await executor(many).execute({
      toolCallId: "c1",
      toolName: DISCOVER_TOOLS_NAME,
      arguments: { query: "read", limit: 999 },
    });
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    // The server limit wins; a caller cannot ask for everything.
    assert.equal(text.startsWith("8 tool(s) matched"), true);
  });

  it("treats a missing query as empty rather than throwing", async () => {
    const result = await call({});
    assert.equal(result.status, "succeeded");
    const text = result.status === "succeeded" ? (result.text ?? "") : "";
    assert.match(text, /No tool matched/);
  });

  it("treats a non-object argument as empty", async () => {
    const result = await call("not an object");
    assert.equal(result.status, "succeeded");
  });
});
