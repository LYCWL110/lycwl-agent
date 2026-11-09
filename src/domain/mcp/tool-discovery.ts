/**
 * Active tool discovery.
 *
 * A project with many MCP servers can advertise hundreds of tools. Putting every
 * schema in every request costs context on each round, pushes the static prefix
 * past the point where it stays cacheable, and makes the model's choice harder
 * rather than easier.
 *
 * Discovery inverts the order: the model is told what servers and tools exist as a
 * compact catalog, and asks for the schemas of the few it wants. This follows the
 * two-level match described in the book: first narrow to candidate servers, then to
 * candidate tools within them.
 *
 * The match is deliberately lexical rather than semantic. A semantic match would
 * need an embedding model, which is a dependency and a privacy question this
 * Harness has not answered. Lexical matching on the name, description and server id
 * is weaker but explainable: a user can see why a tool was offered.
 */

export const DISCOVERY_LIMITS = Object.freeze({
  /** Tools returned by one discovery call. */
  maxResults: 8,
  /** Query length accepted. */
  maxQueryLength: 200,
  /** Below this many total tools, everything is sent and discovery is unnecessary. */
  alwaysLoadBelow: 24,
});

export type DiscoverableTool = Readonly<{
  /** Namespaced name, for example `mcp__files__read_file`. */
  name: string;
  /** Server the tool belongs to. */
  serverId: string;
  /** The tool's own name, without the namespace. */
  toolName: string;
  description: string;
  /** The server's argument schema, returned when the tool is discovered. */
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export type DiscoveryMatch = Readonly<{
  tool: DiscoverableTool;
  score: number;
  /** Why this tool matched, so the model can judge rather than trust a number. */
  reason: string;
}>;

export type DiscoveryResult = Readonly<{
  matches: readonly DiscoveryMatch[];
  /** Servers that exist, so the model knows the full scope it could ask about. */
  servers: readonly string[];
  /** True when the query produced nothing and the caller should say so plainly. */
  empty: boolean;
}>;

/**
 * Split a query into lowercase terms.
 *
 * A term must be at least two characters: a single letter matches almost every
 * description and would make every tool a candidate.
 */
export function queryTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((term) => term.length >= 2);
}

/**
 * Score one tool against the query terms.
 *
 * The weights encode what actually helps a model pick: a name match is stronger
 * than a description match, and a server match is the weakest because every tool
 * from that server shares it. A tool that matches nothing scores zero.
 */
export function scoreTool(tool: DiscoverableTool, terms: readonly string[]): DiscoveryMatch | null {
  if (terms.length === 0) return null;
  const name = tool.toolName.toLowerCase();
  const namespaced = tool.name.toLowerCase();
  const server = tool.serverId.toLowerCase();
  const description = tool.description.toLowerCase();

  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    if (name === term) {
      score += 10;
      reasons.push(`name is "${term}"`);
      continue;
    }
    if (name.includes(term)) {
      score += 6;
      reasons.push(`name contains "${term}"`);
      continue;
    }
    if (namespaced.includes(term)) {
      score += 4;
      reasons.push(`namespaced name contains "${term}"`);
      continue;
    }
    if (description.includes(term)) {
      score += 2;
      reasons.push(`description contains "${term}"`);
      continue;
    }
    if (server.includes(term)) {
      score += 1;
      reasons.push(`server "${term}"`);
    }
  }
  if (score === 0) return null;
  return { tool, score, reason: reasons.join("; ") };
}

/**
 * Find the tools a query refers to.
 *
 * Ties are broken by name so the result is deterministic: the model may see the
 * same list twice, and an unstable order would make it look like the tool set
 * changed.
 */
export function discoverTools(
  tools: readonly DiscoverableTool[],
  query: string,
  limit: number = DISCOVERY_LIMITS.maxResults,
): DiscoveryResult {
  const servers = [...new Set(tools.map((tool) => tool.serverId))].sort();
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > DISCOVERY_LIMITS.maxQueryLength) {
    return { matches: [], servers, empty: true };
  }

  const terms = queryTerms(trimmed);
  const scored: DiscoveryMatch[] = [];
  for (const tool of tools) {
    const match = scoreTool(tool, terms);
    if (match !== null) scored.push(match);
  }

  scored.sort((left, right) =>
    right.score === left.score
      ? left.tool.name < right.tool.name
        ? -1
        : left.tool.name > right.tool.name
          ? 1
          : 0
      : right.score - left.score,
  );

  const matches = scored.slice(0, Math.max(0, limit));
  return { matches, servers, empty: matches.length === 0 };
}

/**
 * Whether discovery should be used at all.
 *
 * With a small tool set, discovery adds a round trip and hides tools the model
 * could simply have been given. The threshold is where a full listing starts to
 * cost more than an extra request.
 */
export function shouldDiscover(totalTools: number): boolean {
  return totalTools > DISCOVERY_LIMITS.alwaysLoadBelow;
}

/**
 * A compact catalog line for the system context.
 *
 * One line per server, not per tool: the point is to tell the model what scope
 * exists without spending the tokens the schemas would have cost.
 */
export function renderServerCatalog(
  tools: readonly DiscoverableTool[],
  maxServers: number = 16,
): string {
  const byServer = new Map<string, number>();
  for (const tool of tools) byServer.set(tool.serverId, (byServer.get(tool.serverId) ?? 0) + 1);
  const entries = [...byServer.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  const shown = entries.slice(0, maxServers);
  const lines = shown.map(([server, count]) => `- ${server}: ${count} tool(s)`);
  if (entries.length > shown.length) {
    lines.push(`- (${entries.length - shown.length} more server(s))`);
  }
  return lines.join("\n");
}
