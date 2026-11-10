import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  createReadFileTool,
  READ_FILE_DEFINITION,
  type ReadFileToolDependencies,
} from "../../src/adapters/tools/read-file-tool.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import type { FileSnapshotFacts } from "../../src/services/files/consistent-snapshot.ts";

function facts(size: number, identity = "file-1"): FileSnapshotFacts {
  return { identity, size, lastWriteTimeNs: 1n, isFile: true, isSymbolicLink: false };
}

class ScriptedApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  readonly #decision: "approved" | "denied";

  constructor(decision: "approved" | "denied") {
    this.#decision = decision;
  }

  async decide(request: ApprovalRequest): Promise<"approved" | "denied"> {
    this.requests.push(request);
    return this.#decision;
  }
}

function dependencies(
  content: string,
  options: {
    approval?: "approved" | "denied";
    resolvedPath?: string;
    snapshot?: FileSnapshotFacts;
  } = {},
): ReadFileToolDependencies & { approvals: ScriptedApproval; reads: () => number } {
  const approvals = new ScriptedApproval(options.approval ?? "denied");
  let reads = 0;
  let nextId = 1;
  const snapshot = options.snapshot ?? facts(Buffer.byteLength(content));
  return {
    workspaceRoot: "D:\\repo",
    approvals,
    ids: { create: () => `id-${nextId++}` },
    inspectTarget: async (requestedPath) => ({
      snapshot,
      target: {
        requestedPath,
        resolvedPath: options.resolvedPath ?? `D:\\repo\\${requestedPath}`,
        isDirectory: false,
        isSymbolicLink: false,
      },
    }),
    readBytes: async () => {
      reads += 1;
      return Buffer.from(content, "utf8");
    },
    reads: () => reads,
  };
}

describe("read_file tool executor", () => {
  it("exposes only the read_file definition", () => {
    const tool = createReadFileTool(dependencies("x"));
    assert.deepEqual(tool.getDefinition("read_file"), READ_FILE_DEFINITION);
    assert.equal(tool.getDefinition("write_note"), null);
  });

  it("reads an ordinary workspace file without approval", async () => {
    const deps = dependencies("one\ntwo\nthree\n");
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "src\\file.txt" },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.equal(deps.reads(), 1);
    assert.equal(deps.approvals.requests.length, 0);
    assert.match(result.text ?? "", /read_file: lines 1-3/);
    assert.match(result.text ?? "", /lineEndings lf/);
    assert.match(result.text ?? "", /modelText complete/);
    assert.match(result.text ?? "", /one\ntwo\nthree\n$/);
  });

  it("honours startLine and lineCount", async () => {
    const deps = dependencies("one\ntwo\nthree\nfour\n");
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "f.txt", startLine: 2, lineCount: 2 },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /read_file: lines 2-3/);
    assert.match(result.text ?? "", /two\nthree\n$/);
  });

  it("returns an explicit empty slice beyond EOF", async () => {
    const deps = dependencies("one\ntwo\n");
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "f.txt", startLine: 99 },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /empty slice at line 99/);
  });

  it("requires approval for a sensitive path and reads nothing when denied", async () => {
    const deps = dependencies("SECRET=1\n", { approval: "denied" });
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: ".env.local" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "approval_denied", text: null });
    assert.equal(deps.approvals.requests.length, 1);
    assert.equal(deps.reads(), 0);
    assert.match(deps.approvals.requests[0]?.safePreview ?? "", /read_file/);
    assert.match(deps.approvals.requests[0]?.safePreview ?? "", /resolved=D:\\repo\\\.env\.local/);
  });

  it("reads a sensitive path once approved", async () => {
    const deps = dependencies("SECRET=1\n", { approval: "approved" });
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: ".env.local" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(deps.reads(), 1);
  });

  it("requires approval for a resolved path outside the workspace", async () => {
    const content = "outside\n";
    const deps = dependencies(content, { resolvedPath: "D:\\elsewhere\\file.txt" });
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "link-to-outside.txt" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "approval_denied");
    assert.equal(deps.reads(), 0);
  });

  it("rejects a traversal path before approval", async () => {
    const deps = dependencies("x");
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "..\\..\\elsewhere\\file.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "invalid_path", text: null });
    assert.equal(deps.reads(), 0);
  });

  it("rejects malformed arguments before any inspection", async () => {
    const deps = dependencies("x");
    const tool = createReadFileTool(deps);

    for (const args of [
      null,
      {},
      { path: "" },
      { path: "f.txt", startLine: 0 },
      { path: "f.txt", lineCount: 0 },
      { path: "f.txt", startLine: 1.5 },
      { path: "f.txt", encoding: "shift-jis" },
    ]) {
      const result = await tool.execute({
        toolCallId: "call-1",
        toolName: "read_file",
        arguments: args,
      });
      assert.equal(result.status, "failed");
      if (result.status !== "failed") continue;
      assert.equal(
        result.safeCode === "invalid_arguments" || result.safeCode === "invalid_line_range",
        true,
      );
    }
    assert.equal(deps.reads(), 0);
  });

  it("reports a directory target without reading", async () => {
    const deps = dependencies("x");
    const tool = createReadFileTool({
      ...deps,
      inspectTarget: async (requestedPath) => ({
        snapshot: facts(0),
        target: {
          requestedPath,
          resolvedPath: `D:\\repo\\${requestedPath}`,
          isDirectory: true,
          isSymbolicLink: false,
        },
      }),
    });

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "src" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "directory_target", text: null });
    assert.equal(deps.reads(), 0);
  });

  it("reports a symbolic link target without reading", async () => {
    const deps = dependencies("x");
    const tool = createReadFileTool({
      ...deps,
      inspectTarget: async (requestedPath) => ({
        snapshot: facts(1),
        target: {
          requestedPath,
          resolvedPath: `D:\\repo\\${requestedPath}`,
          isDirectory: false,
          isSymbolicLink: true,
        },
      }),
    });

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "link.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "symbolic_link", text: null });
    assert.equal(deps.reads(), 0);
  });

  it("rejects an oversized file before reading", async () => {
    const deps = dependencies("x", { snapshot: facts(5 * 1024 * 1024 + 1) });
    const tool = createReadFileTool(deps);

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "big.txt" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "file_too_large", text: null });
    assert.equal(deps.reads(), 0);
  });

  it("fails on non-UTF-8 bytes rather than emitting replacement text", async () => {
    const bad = Buffer.from([0xff, 0xfe, 0xfd]);
    const deps = dependencies("x", { snapshot: facts(bad.byteLength) });
    const tool = createReadFileTool({
      ...deps,
      readBytes: async () => bad,
    });

    const result = await tool.execute({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "binary.bin" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "decoding_failed");
  });
});
