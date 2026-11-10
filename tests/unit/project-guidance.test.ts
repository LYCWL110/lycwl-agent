import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkGuidanceBudget,
  discoverProjectGuidance,
  guidanceApplicationOrder,
  PROJECT_GUIDANCE_LIMITS,
} from "../../src/domain/context/project-guidance.ts";

/**
 * Discovery is a pure function over observed directory listings, so these tests
 * need no filesystem and cannot accidentally cause a read.
 */
function discover(input: {
  workspaceRoot: string;
  targetPath: string;
  targetIsDirectory?: boolean;
  listings: Record<string, readonly string[]>;
}) {
  return discoverProjectGuidance({
    workspaceRoot: input.workspaceRoot,
    targetPath: input.targetPath,
    targetIsDirectory: input.targetIsDirectory === true,
    entriesFor: (directory) => input.listings[directory] ?? [],
  });
}

describe("AGENTS.md discovery order", () => {
  it("returns root to target order for a nested file", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\src\\deep\\file.ts",
      listings: {
        "C:\\ws": ["AGENTS.md", "src"],
        "C:\\ws\\src": ["AGENTS.md", "deep"],
        "C:\\ws\\src\\deep": ["AGENTS.md", "file.ts"],
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.path),
      ["C:\\ws\\AGENTS.md", "C:\\ws\\src\\AGENTS.md", "C:\\ws\\src\\deep\\AGENTS.md"],
    );
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.depth),
      [0, 1, 2],
    );
  });

  it("includes the target directory's own AGENTS.md for a directory target", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\src",
      targetIsDirectory: true,
      listings: { "C:\\ws": ["AGENTS.md"], "C:\\ws\\src": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidates.length, 2);
  });

  it("excludes the target's own AGENTS.md for a file target", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\src\\file.ts",
      targetIsDirectory: false,
      listings: { "C:\\ws": ["AGENTS.md"], "C:\\ws\\src": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Only the root applies: a file target's directory is the parent, and the
    // loop covers root..parent inclusive, so `src` IS the parent here.
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.path),
      ["C:\\ws\\AGENTS.md", "C:\\ws\\src\\AGENTS.md"],
    );
  });

  it("skips levels with no AGENTS.md without reordering the rest", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\a\\b\\c\\file.ts",
      listings: { "C:\\ws": ["AGENTS.md"], "C:\\ws\\a\\b\\c": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.path),
      ["C:\\ws\\AGENTS.md", "C:\\ws\\a\\b\\c\\AGENTS.md"],
    );
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.depth),
      [0, 3],
    );
  });

  it("matches the basename case-insensitively", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\src\\file.ts",
      listings: { "C:\\ws": ["agents.md"], "C:\\ws\\src": [] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidates.length, 1);
    assert.match(result.candidates[0]?.path ?? "", /agents\.md$/);
  });

  it("does not fall back to other instruction filenames", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\src\\file.ts",
      listings: { "C:\\ws": ["README.md", "CLAUDE.md", "notes.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.candidates, []);
  });
});

describe("AGENTS.md discovery boundaries", () => {
  it("rejects a target outside the workspace", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\other\\file.ts",
      listings: {},
    });
    assert.deepEqual(result, { ok: false, code: "target_outside_workspace" });
  });

  it("does not walk above the workspace root", () => {
    const result = discover({
      workspaceRoot: "C:\\ws\\project",
      targetPath: "C:\\ws\\project\\src\\file.ts",
      listings: { "C:\\ws": ["AGENTS.md"], "C:\\ws\\project": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The ancestor outside the workspace must never appear.
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.path),
      ["C:\\ws\\project\\AGENTS.md"],
    );
  });

  it("rejects a relative workspace root", () => {
    const result = discover({ workspaceRoot: "ws", targetPath: "C:\\ws\\a", listings: {} });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_workspace_root");
  });

  it("fails instead of choosing between case-ambiguous candidates", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\file.ts",
      listings: { "C:\\ws": ["AGENTS.md", "agents.md"] },
    });
    assert.deepEqual(result, { ok: false, code: "case_ambiguous_candidates" });
  });

  it("treats forward slashes as separators", () => {
    const result = discover({
      workspaceRoot: "C:/ws",
      targetPath: "C:/ws/src/file.ts",
      listings: { "C:\\ws": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidates.length, 1);
  });

  it("keeps application order stable", () => {
    const result = discover({
      workspaceRoot: "C:\\ws",
      targetPath: "C:\\ws\\a\\b\\file.ts",
      listings: { "C:\\ws": ["AGENTS.md"], "C:\\ws\\a": ["AGENTS.md"] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const shuffled = [...result.candidates].reverse();
    assert.deepEqual(
      guidanceApplicationOrder(shuffled).map((candidate) => candidate.path),
      result.candidates.map((candidate) => candidate.path),
    );
  });
});

describe("guidance size budget", () => {
  it("accepts sizes within both bounds", () => {
    assert.deepEqual(checkGuidanceBudget([1024, 2048]), { ok: true });
  });

  it("rejects a single file above the per-file bound", () => {
    assert.deepEqual(checkGuidanceBudget([PROJECT_GUIDANCE_LIMITS.maxFileBytes + 1]), {
      ok: false,
      code: "file_too_large",
    });
  });

  it("rejects a total above the aggregate bound", () => {
    const each = PROJECT_GUIDANCE_LIMITS.maxFileBytes;
    const count = Math.ceil(PROJECT_GUIDANCE_LIMITS.maxTotalBytes / each) + 1;
    assert.deepEqual(checkGuidanceBudget(Array.from({ length: count }, () => each)), {
      ok: false,
      code: "total_too_large",
    });
  });

  it("rejects a negative or non-integer size", () => {
    assert.deepEqual(checkGuidanceBudget([-1]), { ok: false, code: "invalid_size" });
    assert.deepEqual(checkGuidanceBudget([1.5]), { ok: false, code: "invalid_size" });
  });
});
