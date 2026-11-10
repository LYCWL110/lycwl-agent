import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BATCH_LIMITS,
  type DeleteTargetFacts,
  describeBatch,
  type RenameFacts,
  stopRemaining,
  summarizeBatch,
  type TargetFact,
  validateDeleteTargets,
  validateRename,
} from "../../src/domain/mutation/batch.ts";

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

describe("batch outcome aggregation", () => {
  it("succeeds only when every target applied", () => {
    const status = summarizeBatch([
      { target: "a", outcome: "applied", safeCode: null },
      { target: "b", outcome: "applied", safeCode: null },
    ]);
    assert.equal(status.kind, "succeeded");
  });

  it("fails when a target failed without an unknown", () => {
    const status = summarizeBatch([
      { target: "a", outcome: "applied", safeCode: null },
      { target: "b", outcome: "failed", safeCode: "conflict" },
      { target: "c", outcome: "not_attempted", safeCode: null },
    ]);
    assert.equal(status.kind, "failed");
  });

  it("lets an unknown target win over failure", () => {
    const status = summarizeBatch([
      { target: "a", outcome: "failed", safeCode: "conflict" },
      { target: "b", outcome: "outcome_unknown", safeCode: null },
    ]);
    assert.equal(status.kind, "outcome_unknown");
  });

  it("reports cancelled when the stop reason is cancellation", () => {
    const status = summarizeBatch([
      { target: "a", outcome: "applied", safeCode: null },
      { target: "b", outcome: "failed", safeCode: "cancelled" },
      { target: "c", outcome: "not_attempted", safeCode: null },
    ]);
    assert.equal(status.kind, "cancelled");
  });

  it("marks remaining targets not attempted without claiming no change", () => {
    const existing: TargetFact[] = [
      { target: "a", outcome: "applied", safeCode: null },
      { target: "b", outcome: "failed", safeCode: "conflict" },
    ];
    const full = stopRemaining(existing, ["c", "d"]);
    assert.deepEqual(
      full.map((fact) => `${fact.target}:${fact.outcome}`),
      ["a:applied", "b:failed", "c:not_attempted", "d:not_attempted"],
    );
  });

  it("describes every per-target fact", () => {
    const text = describeBatch({
      kind: "failed",
      targets: [
        { target: "a", outcome: "applied", safeCode: null },
        { target: "b", outcome: "failed", safeCode: "conflict" },
      ],
    });
    assert.match(text, /batch: failed/);
    assert.match(text, /applied a/);
    assert.match(text, /failed b \(conflict\)/);
  });
});

describe("delete target preflight", () => {
  it("accepts ordinary files and empty directories", () => {
    const result = validateDeleteTargets(
      ["a.txt", "empty-dir"],
      [file("a.txt"), file("empty-dir", { isDirectory: true, isEmptyDirectory: true })],
    );
    assert.equal(result.ok, true);
  });

  it("refuses recursive deletion outright", () => {
    assert.deepEqual(validateDeleteTargets(["a"], [file("a")], { recursive: true }), {
      ok: false,
      code: "recursive_unsupported",
    });
  });

  it("refuses more than 16 targets", () => {
    const paths = Array.from(
      { length: BATCH_LIMITS.maxDeleteTargets + 1 },
      (_, index) => `f${index}`,
    );
    assert.deepEqual(
      validateDeleteTargets(
        paths,
        paths.map((path) => file(path)),
      ),
      { ok: false, code: "too_many_targets" },
    );
  });

  it("rejects duplicate targets case-insensitively", () => {
    assert.deepEqual(validateDeleteTargets(["A.txt", "a.txt"], [file("A.txt"), file("a.txt")]), {
      ok: false,
      code: "duplicate_target",
    });
  });

  it("treats a missing target as a conflict, not success", () => {
    assert.deepEqual(validateDeleteTargets(["gone.txt"], [file("gone.txt", { exists: false })]), {
      ok: false,
      code: "missing_target",
    });
  });

  it("refuses non-empty directories and reparse points", () => {
    assert.deepEqual(
      validateDeleteTargets(["dir"], [file("dir", { isDirectory: true, isEmptyDirectory: false })]),
      { ok: false, code: "directory_not_empty" },
    );
    assert.deepEqual(validateDeleteTargets(["link"], [file("link", { isSymbolicLink: true })]), {
      ok: false,
      code: "reparse_point_unsupported",
    });
  });
});

describe("rename preflight", () => {
  it("accepts one same-volume no-overwrite pair", () => {
    assert.equal(validateRename(renameFacts()).ok, true);
  });

  it("refuses an existing target instead of overwriting", () => {
    assert.deepEqual(validateRename(renameFacts({ targetExists: true })), {
      ok: false,
      code: "target_exists",
    });
  });

  it("refuses a cross-volume move", () => {
    assert.deepEqual(validateRename(renameFacts({ sameVolume: false })), {
      ok: false,
      code: "different_volume",
    });
  });

  it("refuses a target inside the source tree", () => {
    assert.deepEqual(validateRename(renameFacts({ targetInsideSource: true })), {
      ok: false,
      code: "target_inside_source",
    });
  });

  it("refuses reparse sources and ambiguous aliases", () => {
    assert.deepEqual(validateRename(renameFacts({ sourceIsSymbolicLink: true })), {
      ok: false,
      code: "reparse_point_unsupported",
    });
    assert.deepEqual(validateRename(renameFacts({ aliasAmbiguous: true })), {
      ok: false,
      code: "path_alias_ambiguous",
    });
  });

  it("fails rather than degrading an oversized tree preview", () => {
    assert.deepEqual(
      validateRename(renameFacts({ treeEntries: BATCH_LIMITS.maxRenameTreeEntries + 1 })),
      { ok: false, code: "tree_too_large" },
    );
    assert.deepEqual(
      validateRename(renameFacts({ manifestBytes: BATCH_LIMITS.maxRenameManifestBytes + 1 })),
      { ok: false, code: "tree_too_large" },
    );
  });

  it("refuses a missing source or empty path", () => {
    assert.deepEqual(validateRename(renameFacts({ sourceExists: false })), {
      ok: false,
      code: "source_missing",
    });
    assert.deepEqual(validateRename(renameFacts({ from: "" })), {
      ok: false,
      code: "invalid_arguments",
    });
  });
});
