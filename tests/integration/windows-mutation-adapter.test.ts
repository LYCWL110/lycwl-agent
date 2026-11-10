import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-mut-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function tools() {
  return createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "approved" },
    ids: { create: () => `id-${Math.random().toString(16).slice(2)}` },
    enableWrites: true,
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("delete_path on real disk", () => {
  it("deletes one ordinary file", async () => {
    await writeFile(path.join(root, "d1.txt"), "x");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["d1.txt"] },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(await exists(path.join(root, "d1.txt")), false);
  });

  it("deletes one empty directory", async () => {
    await mkdir(path.join(root, "emptydir"));
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["emptydir"] },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(await exists(path.join(root, "emptydir")), false);
  });

  it("refuses a non-empty directory and changes nothing", async () => {
    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full", "keep.txt"), "keep");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["full"] },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "directory_not_empty",
      text: null,
    });
    assert.equal(await exists(path.join(root, "full", "keep.txt")), true);
  });

  it("refuses to delete a symlink and leaves it present", async () => {
    await writeFile(path.join(root, "target.txt"), "t");
    const linkPath = path.join(root, "link.txt");
    try {
      await symlink(path.join(root, "target.txt"), linkPath, "file");
    } catch {
      return;
    }
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["link.txt"] },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "reparse_point_unsupported",
      text: null,
    });
    assert.equal(await exists(linkPath), true);
    assert.equal(await exists(path.join(root, "target.txt")), true);
  });

  it("treats a missing target as a conflict", async () => {
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["never-existed.txt"] },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "missing_target", text: null });
  });

  it("refuses recursive deletion before touching anything", async () => {
    await mkdir(path.join(root, "recurse"));
    await writeFile(path.join(root, "recurse", "a.txt"), "a");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["recurse"], recursive: true },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "recursive_unsupported",
      text: null,
    });
    assert.equal(await exists(path.join(root, "recurse", "a.txt")), true);
  });
});

describe("rename_path on real disk", () => {
  it("renames one file and preserves its content", async () => {
    await writeFile(path.join(root, "r1.txt"), "content\n");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "r1.txt", to: "r2.txt" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(await exists(path.join(root, "r1.txt")), false);
    assert.equal(await readFile(path.join(root, "r2.txt"), "utf8"), "content\n");
  });

  it("refuses to overwrite an existing target", async () => {
    await writeFile(path.join(root, "src.txt"), "source\n");
    await writeFile(path.join(root, "dst.txt"), "destination\n");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "src.txt", to: "dst.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "target_exists", text: null });
    assert.equal(await readFile(path.join(root, "src.txt"), "utf8"), "source\n");
    assert.equal(await readFile(path.join(root, "dst.txt"), "utf8"), "destination\n");
  });

  it("renames a directory tree", async () => {
    await mkdir(path.join(root, "tree-a"));
    await writeFile(path.join(root, "tree-a", "x.txt"), "x");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "tree-a", to: "tree-b" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(await exists(path.join(root, "tree-a")), false);
    assert.equal(await readFile(path.join(root, "tree-b", "x.txt"), "utf8"), "x");
  });

  it("refuses to move a directory into its own subtree", async () => {
    await mkdir(path.join(root, "outer"));
    await mkdir(path.join(root, "outer", "inner"));
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "outer", to: "outer\\inner\\moved" },
    });

    assert.equal(result.status, "failed");
    assert.equal(await exists(path.join(root, "outer", "inner")), true);
  });

  it("refuses a missing source", async () => {
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "ghost.txt", to: "other.txt" },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "source_missing", text: null });
  });
});

describe("mutation tools stay gated", () => {
  it("fails closed when the build is read-only", async () => {
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "id" },
      enableWrites: false,
    });
    for (const toolName of ["delete_path", "rename_path"]) {
      const result = await t.execute({
        toolCallId: "c1",
        toolName,
        arguments: { paths: ["x"], from: "a", to: "b" },
      });
      assert.deepEqual(result, {
        status: "failed",
        safeCode: "tool_unavailable_in_build",
        text: null,
      });
    }
  });

  it("requires approval for delete", async () => {
    const requests: unknown[] = [];
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: {
        decide: async (request) => {
          requests.push(request);
          return "denied";
        },
      },
      ids: { create: () => "id" },
      enableWrites: true,
    });
    await writeFile(path.join(root, "approval-needed.txt"), "x");

    // Direct execution bypasses approval by design; the gate is exercised by
    // the Runtime tests. Here we only confirm the tool declares it needs one.
    const definition = t.getDefinition("delete_path");
    assert.equal(definition?.requiresApproval, true);
  });
});
