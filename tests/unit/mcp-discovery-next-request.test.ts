import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDiscoverToolsTool,
  DISCOVER_TOOLS_NAME,
  DISCOVERY_TOOL_DESCRIPTION,
  DISCOVERY_TOOL_SCHEMA,
} from "../../src/adapters/tools/discover-tools.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { DiscoverableTool } from "../../src/domain/mcp/tool-discovery.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

const mcpTool: DiscoverableTool = {
  name: "mcp__files__read_text",
  serverId: "files",
  toolName: "read_text",
  description: "Read a text file from the server.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

describe("MCP discovery reaches the next request", () => {
  it("declares a discovered schema before the model can call it", async () => {
    const discover = createDiscoverToolsTool({ tools: () => [mcpTool] });
    const provider = new ScriptedProvider([
      {
        kind: "completed",
        text: null,
        toolCalls: [
          {
            providerToolCallId: "discover-1",
            toolName: DISCOVER_TOOLS_NAME,
            arguments: { query: "read_text" },
          },
        ],
      },
      { kind: "completed", text: "found it", toolCalls: [] },
    ]);
    const ids = new SequenceIds("discovery");
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: discover,
      toolDefinitions: [
        {
          name: DISCOVER_TOOLS_NAME,
          description: DISCOVERY_TOOL_DESCRIPTION,
          inputSchema: DISCOVERY_TOOL_SCHEMA,
        },
      ],
      extraToolDefinitions: [
        {
          name: mcpTool.name,
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema,
        },
      ],
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-26T00:00:00.000Z",
    });

    await coordinator.run("find the file tool");
    const second = provider.requests[1];
    assert.ok(second);
    assert.equal(
      second.tools?.some((tool) => tool.name === "mcp__files__read_text"),
      true,
    );
    await coordinator.closeSession("close");
  });
});
