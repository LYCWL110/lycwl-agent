import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  APPLY_PATCH_DEFINITION,
  createApplyPatchTool,
  type PatchTargetSnapshot,
} from "../../src/adapters/tools/patch-tool.ts";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Fixture = {
  tool: ReturnType<typeof createApplyPatchTool>;
  writes: { path: string; text: string }[];
  setFile: (path: string, text: string) => void;
  removeFile: (path: string) => void;
  failOn?: string;
};

function fixture(initial: Record<string, string>): Fixture {
  const files = new Map<string, Buffer>();
  for (const [path, text] of Object.entries(initial)) {
    files.set(path, Buffer.from(text, "utf8"));
  }
  const writes: { path: string; text: string }[] = [];
  const state: Fixture = {
    writes,
    setFile: (path, text) => {
      files.set(path, Buffer.from(text, "utf8"));
    },
    removeFile: (path) => {
      files.delete(path);
    },
    tool: undefined as never,
  };

  state.tool = createApplyPatchTool({
    inspectTargets: async (paths): Promise<readonly PatchTargetSnapshot[]> =>
      paths.map((path) => {
        const bytes = files.get(path);
        return {
          path,
          exists: bytes !== undefined,
          sha256: bytes === undefined ? null : sha(bytes),
          encoding: "utf-8",
          lineEnding: "lf",
          bytes: bytes ?? Buffer.alloc(0),
        };
      }),
    writeBytes: async (path, bytes) => {
      if (state.failOn === path) throw new Error("locked");
      writes.push({ path, text: Buffer.from(bytes).toString("utf8") });
      files.set(path, Buffer.from(bytes));
    },
  });
  return state;
}

const ONE_TARGET_PATCH = [
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
].join("\n");

const TWO_TARGET_PATCH = [
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,1 @@",
  "-a1",
  "+A1",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,1 @@",
  "-b1",
  "+B1",
].join("\n");

describe("apply_patch definition", () => {
  it("is an approval-required filesystem mutation", () => {
    const f = fixture({});
    assert.deepEqual(f.tool.getDefinition("apply_patch"), APPLY_PATCH_DEFINITION);
    assert.equal(APPLY_PATCH_DEFINITION.requiresApproval, true);
    assert.equal(APPLY_PATCH_DEFINITION.sideEffectClass, "filesystem_mutation");
  });
});

describe("apply_patch execution", () => {
  it("applies a single-file patch", async () => {
    const f = fixture({ "a.ts": "keep\nold\n" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: ONE_TARGET_PATCH },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.writes, [{ path: "a.ts", text: "keep\nnew\n" }]);
    assert.match(result.text ?? "", /batch: succeeded/);
  });

  it("applies multiple targets serially", async () => {
    const f = fixture({ "a.ts": "a1\n", "b.ts": "b1\n" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: TWO_TARGET_PATCH },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(
      f.writes.map((write) => `${write.path}:${write.text.trim()}`),
      ["a.ts:A1", "b.ts:B1"],
    );
  });

  it("stops at a failed target and marks the rest not attempted", async () => {
    const f = fixture({ "a.ts": "a1\n", "b.ts": "b1\n" });
    f.failOn = "a.ts";
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: TWO_TARGET_PATCH },
    });

    assert.equal(result.status, "outcome_unknown");
    assert.match(result.text ?? "", /outcome_unknown a\.ts/);
    assert.match(result.text ?? "", /not_attempted b\.ts/);
    assert.equal(f.writes.length, 0);
  });

  it("refuses the batch when any target changed after preflight", async () => {
    const f = fixture({ "a.ts": "a1\n", "b.ts": "b1\n" });
    const originalInspect = f.tool;
    let calls = 0;
    const tool = createApplyPatchTool({
      inspectTargets: async (paths) => {
        calls += 1;
        const snapshot = await originalInspect.getDefinition("apply_patch");
        assert.notEqual(snapshot, null);
        return paths.map((path) => {
          const text = path === "a.ts" ? (calls === 1 ? "a1\n" : "changed\n") : "b1\n";
          const bytes = Buffer.from(text, "utf8");
          return {
            path,
            exists: true,
            sha256: sha(bytes),
            encoding: "utf-8" as const,
            lineEnding: "lf",
            bytes,
          };
        });
      },
      writeBytes: async () => undefined,
    });

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: TWO_TARGET_PATCH },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "file_conflict");
  });

  it("refuses a context mismatch before writing anything", async () => {
    const f = fixture({ "a.ts": "keep\nDIFFERENT\n" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: ONE_TARGET_PATCH },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "context_mismatch",
      text: null,
    });
    assert.equal(f.writes.length, 0);
  });

  it("rejects a malformed patch", async () => {
    const f = fixture({});
    for (const patch of ["", "not a diff", "--- a/f\n+++ b/f"]) {
      const result = await f.tool.execute({
        toolCallId: "call-1",
        toolName: "apply_patch",
        arguments: { patch },
      });
      assert.equal(result.status, "failed");
    }
    assert.equal(f.writes.length, 0);
  });

  it("rejects missing arguments", async () => {
    const f = fixture({});
    for (const args of [null, {}, { patch: 42 }]) {
      const result = await f.tool.execute({
        toolCallId: "call-1",
        toolName: "apply_patch",
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

describe("apply_patch preview", () => {
  it("lists every target and states there is no global atomicity", async () => {
    const f = fixture({ "a.ts": "a1\n", "b.ts": "b1\n" });
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: TWO_TARGET_PATCH },
    });

    assert.match(preview ?? "", /targets=a\.ts,b\.ts/);
    assert.match(preview ?? "", /targetCount=2/);
    assert.match(preview ?? "", /no global atomicity/);
    assert.match(preview ?? "", /stop=first failure/);
    assert.equal(f.writes.length, 0);
  });

  it("reports the planning failure instead of a preview", async () => {
    const f = fixture({ "a.ts": "keep\nDIFFERENT\n" });
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: ONE_TARGET_PATCH },
    });
    assert.equal(preview, "apply_patch: context_mismatch");
  });
});
