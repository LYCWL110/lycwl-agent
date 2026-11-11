import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createMutationTools } from "../../src/adapters/tools/mutation-tools.ts";

/**
 * Outcome verification for delete and rename.
 *
 * The rule these tests protect: the verifier inspects state and never repeats the
 * operation. A verifier that re-ran the delete would be the exact mistake this
 * exists to prevent, so these tests give it a delete sink that would be visible if
 * it were called again.
 */

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "verify-outcome-"));
}

/** A dependency set backed by the real file system, counting destructive calls. */
function dependencies(root: string) {
  const calls = { delete: 0, rename: 0 };
  return {
    calls,
    deps: {
      async inspectDeleteTargets(paths: readonly string[]) {
        return paths.map((target) => {
          const absolute = path.resolve(root, target);
          const exists = existsSync(absolute);
          return {
            path: target,
            exists,
            isDirectory: false,
            isSymbolicLink: false,
            isEmptyDirectory: false,
          };
        });
      },
      async inspectRename(from: string, to: string) {
        return {
          from,
          to,
          sourceExists: existsSync(path.resolve(root, from)),
          targetExists: existsSync(path.resolve(root, to)),
          sameVolume: true,
          sourceIsSymbolicLink: false,
          treeEntries: 1,
          manifestBytes: 1,
          targetInsideSource: false,
          aliasAmbiguous: false,
        };
      },
      async deletePath(target: string) {
        calls.delete += 1;
        const absolute = path.resolve(root, target);
        const { rmSync } = await import("node:fs");
        rmSync(absolute, { force: true });
      },
      async renamePath(from: string, to: string) {
        calls.rename += 1;
        const { renameSync } = await import("node:fs");
        renameSync(path.resolve(root, from), path.resolve(root, to));
      },
    },
  };
}

describe("delete verification", () => {
  it("reports applied when the target is gone", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    const { deps, calls } = dependencies(root);
    const tools = createMutationTools(deps);
    const request = {
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt"] },
    };
    await tools.execute(request);
    const verdict = await tools.verifyOutcome?.(request);
    assert.equal(verdict, "applied");
    // The verifier must not have repeated the delete.
    assert.equal(calls.delete, 1);
  });

  it("reports not_applied when the target is still there", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    const { deps, calls } = dependencies(root);
    const tools = createMutationTools(deps);
    const request = {
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt"] },
    };
    // No execute: the delete never ran, which is exactly the unknown-outcome case.
    const verdict = await tools.verifyOutcome?.(request);
    assert.equal(verdict, "not_applied");
    assert.equal(calls.delete, 0);
  });

  it("reports inconclusive for a partial batch", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    writeFileSync(path.join(root, "b.txt"), "x", "utf8");
    const { deps } = dependencies(root);
    const tools = createMutationTools(deps);
    const request = {
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt", "b.txt"] },
    };
    // Remove only one of the two, as a cancelled batch would.
    const { rmSync } = await import("node:fs");
    rmSync(path.join(root, "a.txt"), { force: true });
    const verdict = await tools.verifyOutcome?.(request);
    // One gone and one present settles nothing about the batch as a whole.
    assert.equal(verdict, "inconclusive");
  });

  it("reports null for invalid arguments rather than guessing", async () => {
    const root = workspace();
    const { deps } = dependencies(root);
    const tools = createMutationTools(deps);
    const verdict = await tools.verifyOutcome?.({
      toolCallId: "c1",
      toolName: "delete_path",
      arguments: { not: "valid" },
    });
    assert.equal(verdict, null);
  });
});

describe("rename verification", () => {
  it("reports applied when the source is gone and the target exists", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    const { deps, calls } = dependencies(root);
    const tools = createMutationTools(deps);
    const request = {
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    };
    await tools.execute(request);
    const verdict = await tools.verifyOutcome?.(request);
    assert.equal(verdict, "applied");
    assert.equal(calls.rename, 1);
  });

  it("reports not_applied when neither end moved", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    const { deps } = dependencies(root);
    const tools = createMutationTools(deps);
    const verdict = await tools.verifyOutcome?.({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });
    assert.equal(verdict, "not_applied");
  });

  it("reports inconclusive when only one end agrees", async () => {
    // Both present means the rename did not happen but something else did; the
    // verifier must not guess which half completed.
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    writeFileSync(path.join(root, "b.txt"), "x", "utf8");
    const { deps } = dependencies(root);
    const tools = createMutationTools(deps);
    const verdict = await tools.verifyOutcome?.({
      toolCallId: "c1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });
    assert.equal(verdict, "inconclusive");
  });
});

describe("tools without a verifier", () => {
  it("does not expose verifyOutcome when the executor has none", async () => {
    const root = workspace();
    mkdirSync(path.join(root, "sub"), { recursive: true });
    const { deps } = dependencies(root);
    const tools = createMutationTools(deps);
    // A read-only tool name has no definition here, so verification returns null
    // rather than inventing an answer.
    const verdict = await tools.verifyOutcome?.({
      toolCallId: "c1",
      toolName: "read_file",
      arguments: { path: "a.txt" },
    });
    assert.equal(verdict, null);
  });
});
