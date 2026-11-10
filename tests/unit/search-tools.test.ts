import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSearchTools,
  type SearchEntry,
  type SearchToolDependencies,
} from "../../src/adapters/tools/search-tools.ts";

const TREE: readonly SearchEntry[] = [
  { path: "src", kind: "directory" },
  { path: "src/a.ts", kind: "file" },
  { path: "src/b.ts", kind: "file" },
  { path: "src/nested", kind: "directory" },
  { path: "src/nested/c.ts", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "build", kind: "directory" },
  { path: "build/out.js", kind: "file" },
];

const FILES: Readonly<Record<string, string>> = {
  "src/a.ts": "const alpha = 1;\nconst beta = 2;\nalpha again\n",
  "src/b.ts": "nothing here\n",
  "src/nested/c.ts": "alpha in nested\n",
  "README.md": "# Title\nalpha docs\n",
  "build/out.js": "alpha built\n",
};

function deps(overrides: Partial<SearchToolDependencies> = {}): SearchToolDependencies & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    listEntries: async (directory) =>
      TREE.filter((entry) => {
        const parent = entry.path.includes("/")
          ? entry.path.slice(0, entry.path.lastIndexOf("/"))
          : "";
        return parent === directory;
      }),
    readText: async (path) => {
      reads.push(path);
      const content = FILES[path];
      if (content === undefined) throw new Error("unreadable");
      return content;
    },
    reads,
    ...overrides,
  };
}

describe("search tool definitions", () => {
  it("exposes exactly the three read-only search tools", () => {
    const tools = createSearchTools(deps());
    for (const name of ["list_dir", "glob", "grep"]) {
      const definition = tools.getDefinition(name);
      assert.notEqual(definition, null);
      assert.equal(definition?.sideEffectClass, "read_only");
      assert.equal(definition?.requiresApproval, false);
    }
    assert.equal(tools.getDefinition("shell"), null);
  });
});

describe("list_dir", () => {
  it("lists one level by default in deterministic order", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "list_dir",
      arguments: {},
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /list_dir: 3 entr/);
    assert.match(result.text ?? "", /scope=complete/);
    const listed = (result.text ?? "").split("\n").slice(2);
    assert.deepEqual(listed, ["README.md", "build/", "src/"]);
  });

  it("walks deeper when depth is raised", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "list_dir",
      arguments: { depth: 2 },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /src\/a\.ts/);
    assert.match(result.text ?? "", /src\/nested\//);
    assert.match(result.text ?? "", /scope=complete/);
  });

  it("reports a limit as reached only with an observed extra entry", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "list_dir",
      arguments: { limit: 2 },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /limit=reached/);
    assert.match(result.text ?? "", /observedExtra=1/);
  });

  it("rejects an out-of-range depth or limit", async () => {
    const tools = createSearchTools(deps());
    for (const args of [{ depth: 33 }, { depth: -1 }, { limit: 0 }, { limit: 1001 }]) {
      const result = await tools.execute({
        toolCallId: "c",
        toolName: "list_dir",
        arguments: args,
      });
      assert.deepEqual(result, { status: "failed", safeCode: "invalid_arguments", text: null });
    }
  });
});

describe("glob", () => {
  it("matches by pattern in deterministic order", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "glob",
      arguments: { pattern: "**/*.ts" },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    const lines = (result.text ?? "").split("\n");
    assert.equal(lines[0], "glob: 3 path(s)");
    assert.deepEqual(lines.slice(2), ["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("supports single-star within a segment", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "glob",
      arguments: { pattern: "*.md" },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /README\.md/);
    assert.doesNotMatch(result.text ?? "", /src\/a\.ts/);
  });

  it("rejects a missing pattern", async () => {
    const tools = createSearchTools(deps());
    assert.deepEqual(await tools.execute({ toolCallId: "c", toolName: "glob", arguments: {} }), {
      status: "failed",
      safeCode: "invalid_arguments",
      text: null,
    });
  });
});

describe("grep", () => {
  it("matches literally by default and counts one hit per line", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "grep",
      arguments: { pattern: "alpha" },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /grep: 5 hit line\(s\)/);
    assert.match(result.text ?? "", /src\/a\.ts:1:const alpha = 1;/);
    assert.match(result.text ?? "", /src\/a\.ts:3:alpha again/);
    assert.match(result.text ?? "", /README\.md:2:alpha docs/);
  });

  it("treats the pattern as a literal unless regex is requested", async () => {
    const tools = createSearchTools(deps());
    const literal = await tools.execute({
      toolCallId: "c1",
      toolName: "grep",
      arguments: { pattern: "a.*a" },
    });
    assert.equal(literal.status, "succeeded");
    if (literal.status !== "succeeded") return;
    assert.match(literal.text ?? "", /grep: 0 hit line/);

    const regex = await tools.execute({
      toolCallId: "c2",
      toolName: "grep",
      arguments: { pattern: "a.*a", regex: true },
    });
    assert.equal(regex.status, "succeeded");
    if (regex.status !== "succeeded") return;
    assert.match(regex.text ?? "", /src\/a\.ts:1:/);
  });

  it("rejects an invalid regular expression instead of falling back", async () => {
    const tools = createSearchTools(deps());
    assert.deepEqual(
      await tools.execute({
        toolCallId: "c",
        toolName: "grep",
        arguments: { pattern: "(", regex: true },
      }),
      { status: "failed", safeCode: "invalid_pattern", text: null },
    );
  });

  it("respects case sensitivity and its explicit opt-out", async () => {
    const tools = createSearchTools(deps());
    const strict = await tools.execute({
      toolCallId: "c1",
      toolName: "grep",
      arguments: { pattern: "ALPHA" },
    });
    assert.equal(strict.status, "succeeded");
    if (strict.status !== "succeeded") return;
    assert.match(strict.text ?? "", /grep: 0 hit line/);

    const loose = await tools.execute({
      toolCallId: "c2",
      toolName: "grep",
      arguments: { pattern: "ALPHA", caseSensitive: false },
    });
    assert.equal(loose.status, "succeeded");
    if (loose.status !== "succeeded") return;
    assert.match(loose.text ?? "", /grep: 5 hit line/);
  });

  it("reports skipped files as an incomplete scope", async () => {
    const tools = createSearchTools(
      deps({
        readText: async (path) => {
          if (path === "src/b.ts") throw new Error("unreadable");
          return FILES[path] ?? "";
        },
      }),
    );
    const result = await tools.execute({
      toolCallId: "c",
      toolName: "grep",
      arguments: { pattern: "alpha" },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /scope=partial/);
    assert.match(result.text ?? "", /skipped=1/);
  });

  it("enforces the context-line bounds", async () => {
    const tools = createSearchTools(deps());
    assert.deepEqual(
      await tools.execute({
        toolCallId: "c",
        toolName: "grep",
        arguments: { pattern: "alpha", contextBefore: 11 },
      }),
      { status: "failed", safeCode: "invalid_arguments", text: null },
    );
  });

  it("applies the limit in deterministic path order", async () => {
    const tools = createSearchTools(deps());
    const result = await tools.execute({
      toolCallId: "c",
      toolName: "grep",
      arguments: { pattern: "alpha", limit: 2 },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /grep: 2 hit line/);
    assert.match(result.text ?? "", /limit=reached/);
    assert.match(result.text ?? "", /observedExtra=3/);
    assert.match(result.text ?? "", /README\.md:2:/);
    assert.match(result.text ?? "", /build\/out\.js:1:/);
  });

  it("skips paths excluded by ignore rules", async () => {
    const tools = createSearchTools({
      ...deps(),
      ignoreRules: [
        {
          source: ".ignore",
          basePath: "",
          pattern: "build",
          negated: false,
          directoryOnly: true,
          anchored: false,
        },
      ],
    });
    const result = await tools.execute({
      toolCallId: "c",
      toolName: "grep",
      arguments: { pattern: "alpha" },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /grep: 4 hit line/);
    assert.doesNotMatch(result.text ?? "", /build\/out\.js/);
  });

  it("marks the scope incomplete when ignore rules could not all be read", async () => {
    const tools = createSearchTools({ ...deps(), ignoreRulesIncomplete: true });
    const result = await tools.execute({
      toolCallId: "c",
      toolName: "grep",
      arguments: { pattern: "alpha" },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /ignoreRules=incomplete/);
    assert.match(result.text ?? "", /scope=complete/);
  });
});
