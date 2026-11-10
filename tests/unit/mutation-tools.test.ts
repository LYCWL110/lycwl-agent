import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMutationTools,
  DELETE_PATH_DEFINITION,
  type MutationToolDependencies,
  RENAME_PATH_DEFINITION,
} from "../../src/adapters/tools/mutation-tools.ts";
import type { DeleteTargetFacts, RenameFacts } from "../../src/domain/mutation/batch.ts";

function file(path: string, overrides: Partial<DeleteTargetFacts> = {}): DeleteTargetFacts {
  return {
    path,
    exists: true,
    isDirectory: false,
    isSymbolicLink: false,
    isEmptyDirectory: false,
    ...overrides,
  };
}

function renameFacts(overrides: Partial<RenameFacts> = {}): RenameFacts {
  return {
    from: "a.txt",
    to: "b.txt",
    sourceExists: true,
    targetExists: false,
    sameVolume: true,
    sourceIsSymbolicLink: false,
    treeEntries: 1,
    manifestBytes: 64,
    targetInsideSource: false,
    aliasAmbiguous: false,
    ...overrides,
  };
}

type Fixture = {
  deps: {
    inspectDeleteTargets: MutationToolDependencies["inspectDeleteTargets"];
    inspectRename: MutationToolDependencies["inspectRename"];
    deletePath: MutationToolDependencies["deletePath"];
    renamePath: MutationToolDependencies["renamePath"];
  };
  deleted: string[];
  renamed: { from: string; to: string }[];
  failOn?: string;
};

function fixture(deleteFacts: readonly DeleteTargetFacts[], rename?: RenameFacts): Fixture {
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const state: Fixture = {
    deleted,
    renamed,
    deps: {
      inspectDeleteTargets: async (paths) => deleteFacts.filter((f) => paths.includes(f.path)),
      inspectRename: async () => rename ?? renameFacts(),
      deletePath: async (path) => {
        if (state.failOn === path) throw new Error("locked");
        deleted.push(path);
      },
      renamePath: async (from, to) => {
        renamed.push({ from, to });
      },
    },
  };
  return state;
}

describe("mutation tool definitions", () => {
  it("declares both tools as approval-required mutations", () => {
    const tools = createMutationTools(fixture([]).deps);
    for (const definition of [DELETE_PATH_DEFINITION, RENAME_PATH_DEFINITION]) {
      assert.equal(tools.getDefinition(definition.name), definition);
      assert.equal(definition.requiresApproval, true);
      assert.equal(definition.sideEffectClass, "filesystem_mutation");
    }
  });
});

describe("delete_path execution", () => {
  it("deletes every preflighted target in order", async () => {
    const f = fixture([file("a.txt"), file("b.txt")]);
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt", "b.txt"] },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.deleted, ["a.txt", "b.txt"]);
    assert.match(result.text ?? "", /batch: succeeded/);
  });

  it("refuses recursive deletion before touching anything", async () => {
    const f = fixture([file("dir", { isDirectory: true, isEmptyDirectory: false })]);
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "delete_path",
      arguments: { paths: ["dir"], recursive: true },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "recursive_unsupported",
      text: null,
    });
    assert.equal(f.deleted.length, 0);
  });

  it("stops after a failure and marks the rest not attempted", async () => {
    const f = fixture([file("a.txt"), file("b.txt"), file("c.txt")]);
    f.failOn = "b.txt";
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt", "b.txt", "c.txt"] },
    });

    assert.equal(result.status, "outcome_unknown");
    assert.deepEqual(f.deleted, ["a.txt"]);
    assert.match(result.text ?? "", /outcome_unknown b\.txt/);
    assert.match(result.text ?? "", /not_attempted c\.txt/);
  });

  it("refuses a missing target as a conflict", async () => {
    const f = fixture([file("gone.txt", { exists: false })]);
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "delete_path",
      arguments: { paths: ["gone.txt"] },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "missing_target", text: null });
    assert.equal(f.deleted.length, 0);
  });

  it("rejects malformed arguments", async () => {
    const tools = createMutationTools(fixture([]).deps);
    for (const args of [null, {}, { paths: [] }, { paths: [""] }, { paths: "a.txt" }]) {
      const result = await tools.execute({
        toolCallId: "call-1",
        toolName: "delete_path",
        arguments: args,
      });
      assert.deepEqual(result, {
        status: "failed",
        safeCode: "invalid_arguments",
        text: null,
      });
    }
  });
});

describe("rename_path execution", () => {
  it("renames one same-volume pair", async () => {
    const f = fixture([], renameFacts());
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.renamed, [{ from: "a.txt", to: "b.txt" }]);
  });

  it("refuses to overwrite an existing target", async () => {
    const f = fixture([], renameFacts({ targetExists: true }));
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "target_exists", text: null });
    assert.equal(f.renamed.length, 0);
  });

  it("refuses a cross-volume rename instead of copying", async () => {
    const f = fixture([], renameFacts({ sameVolume: false }));
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "different_volume", text: null });
    assert.equal(f.renamed.length, 0);
  });

  it("reports outcome_unknown when the rename sink throws", async () => {
    const f = fixture([], renameFacts());
    f.deps.renamePath = async () => {
      throw new Error("sharing violation");
    };
    const tools = createMutationTools(f.deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "rename_outcome_unknown",
    });
  });
});

describe("mutation previews", () => {
  it("states the irreversibility of delete", async () => {
    const tools = createMutationTools(fixture([]).deps);
    const preview = await tools.preview?.({
      toolCallId: "call-1",
      toolName: "delete_path",
      arguments: { paths: ["a.txt"] },
    });
    assert.match(preview ?? "", /targets=a\.txt/);
    assert.match(preview ?? "", /permanently removes/);
    assert.match(preview ?? "", /no trash, backup or restore promise/);
  });

  it("shows the exact rename pair", async () => {
    const tools = createMutationTools(fixture([]).deps);
    const preview = await tools.preview?.({
      toolCallId: "call-1",
      toolName: "rename_path",
      arguments: { from: "a.txt", to: "b.txt" },
    });
    assert.match(preview ?? "", /from=a\.txt/);
    assert.match(preview ?? "", /to=b\.txt/);
    assert.match(preview ?? "", /never overwrites/);
  });
});
