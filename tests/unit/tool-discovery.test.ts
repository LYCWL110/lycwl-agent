import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DISCOVERY_LIMITS,
  type DiscoverableTool,
  discoverTools,
  queryTerms,
  renderServerCatalog,
  scoreTool,
  shouldDiscover,
} from "../../src/domain/mcp/tool-discovery.ts";

/**
 * Active tool discovery.
 *
 * The rule these tests protect: discovery must be explainable. A lexical match can
 * be wrong, but it can be seen — a user or a model can read why a tool was offered.
 * A semantic match would hide that behind a number.
 */

function tool(serverId: string, toolName: string, description = ""): DiscoverableTool {
  return {
    name: `mcp__${serverId}__${toolName}`,
    serverId,
    toolName,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

describe("queryTerms", () => {
  it("splits on non-word characters and lowercases", () => {
    assert.deepEqual(queryTerms("Read File, Please"), ["read", "file", "please"]);
  });

  it("drops single characters", () => {
    // A single letter matches almost every description.
    assert.deepEqual(queryTerms("a read b file"), ["read", "file"]);
  });

  it("keeps underscores, which tool names use", () => {
    assert.deepEqual(queryTerms("read_file"), ["read_file"]);
  });

  it("returns nothing for punctuation only", () => {
    assert.deepEqual(queryTerms("---"), []);
  });
});

describe("scoreTool", () => {
  it("scores an exact name match highest", () => {
    const exact = scoreTool(tool("files", "read"), ["read"]);
    const partial = scoreTool(tool("files", "read_file"), ["read"]);
    assert.notEqual(exact, null);
    assert.notEqual(partial, null);
    assert.ok((exact?.score ?? 0) > (partial?.score ?? 0));
  });

  it("scores a description match lowest", () => {
    const name = scoreTool(tool("files", "read"), ["read"]);
    const description = scoreTool(tool("files", "other", "read a thing"), ["read"]);
    assert.ok((name?.score ?? 0) > (description?.score ?? 0));
  });

  it("returns null when nothing matches", () => {
    assert.equal(scoreTool(tool("files", "read", "read a file"), ["weather"]), null);
  });

  it("explains the match", () => {
    const match = scoreTool(tool("files", "read_file", "read a file"), ["read"]);
    assert.notEqual(match, null);
    assert.match(match?.reason ?? "", /name/);
  });

  it("returns null for an empty term list", () => {
    assert.equal(scoreTool(tool("files", "read"), []), null);
  });
});

describe("discoverTools", () => {
  const tools = [
    tool("files", "read_file", "read a file"),
    tool("files", "write_file", "write a file"),
    tool("github", "list_contributors", "list repository contributors"),
    tool("github", "get_repo_stats", "repository statistics"),
    tool("weather", "get_forecast", "weather forecast"),
  ];

  it("finds a tool by a term in its name", () => {
    const result = discoverTools(tools, "contributors");
    assert.equal(result.empty, false);
    assert.equal(result.matches[0]?.tool.name, "mcp__github__list_contributors");
  });

  it("finds a tool by a term in its description", () => {
    const result = discoverTools(tools, "statistics");
    assert.equal(result.matches[0]?.tool.name, "mcp__github__get_repo_stats");
  });

  it("lists every server, not just the matched ones", () => {
    // The model needs to know the full scope so it can retry with a real term.
    const result = discoverTools(tools, "contributors");
    assert.deepEqual(result.servers, ["files", "github", "weather"]);
  });

  it("returns empty for a query that matches nothing", () => {
    const result = discoverTools(tools, "blockchain");
    assert.equal(result.empty, true);
    assert.deepEqual(result.matches, []);
  });

  it("returns empty for a blank query", () => {
    assert.equal(discoverTools(tools, "   ").empty, true);
  });

  it("returns empty for an over-long query", () => {
    const result = discoverTools(tools, "x".repeat(DISCOVERY_LIMITS.maxQueryLength + 1));
    assert.equal(result.empty, true);
  });

  it("respects the result limit", () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      tool("bulk", `read_${index}`, "read something"),
    );
    const result = discoverTools(many, "read", 3);
    assert.equal(result.matches.length, 3);
  });

  it("orders deterministically when scores tie", () => {
    // The model may see the same list twice; an unstable order would look like the
    // tool set changed.
    const tied = [tool("s", "read_b"), tool("s", "read_a"), tool("s", "read_c")];
    const first = discoverTools(tied, "read");
    const second = discoverTools([...tied].reverse(), "read");
    assert.deepEqual(
      first.matches.map((match) => match.tool.name),
      second.matches.map((match) => match.tool.name),
    );
  });

  it("ranks a server-only match below a name match", () => {
    const result = discoverTools(tools, "github");
    // Every github tool matches by server id; none has "github" in its own name.
    assert.equal(result.matches.length, 2);
    assert.deepEqual(
      result.matches.map((match) => match.tool.serverId),
      ["github", "github"],
    );
  });
});

describe("shouldDiscover", () => {
  it("is false for a small tool set", () => {
    // Discovery adds a round trip; with few tools it costs more than it saves.
    assert.equal(shouldDiscover(5), false);
    assert.equal(shouldDiscover(DISCOVERY_LIMITS.alwaysLoadBelow), false);
  });

  it("is true past the threshold", () => {
    assert.equal(shouldDiscover(DISCOVERY_LIMITS.alwaysLoadBelow + 1), true);
  });
});

describe("renderServerCatalog", () => {
  it("counts tools per server", () => {
    const catalog = renderServerCatalog([
      tool("files", "a"),
      tool("files", "b"),
      tool("github", "c"),
    ]);
    assert.match(catalog, /files: 2 tool/);
    assert.match(catalog, /github: 1 tool/);
  });

  it("is empty when there are no tools", () => {
    assert.equal(renderServerCatalog([]), "");
  });

  it("summarizes the overflow rather than listing every server", () => {
    const many = Array.from({ length: 20 }, (_unused, index) => tool(`s${index}`, "t"));
    const catalog = renderServerCatalog(many, 3);
    assert.match(catalog, /more server/);
    assert.equal(catalog.split("\n").length, 4);
  });
});
