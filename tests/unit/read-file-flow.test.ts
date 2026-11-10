import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import type { FileSnapshotFacts } from "../../src/services/files/consistent-snapshot.ts";
import { runReadFileFlow } from "../../src/services/files/read-file-flow.ts";

function facts(size: number): FileSnapshotFacts {
  return {
    identity: "file-1",
    size,
    lastWriteTimeNs: 1n,
    isFile: true,
    isSymbolicLink: false,
  };
}

class RecordingApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  readonly #decision: "approved" | "denied";

  constructor(decision: "approved" | "denied") {
    this.#decision = decision;
  }

  async decide(request: ApprovalRequest) {
    this.requests.push(request);
    return this.#decision;
  }
}

describe("read_file injected flow", () => {
  it("reads an ordinary workspace file without requesting approval", async () => {
    const approvals = new RecordingApproval("denied");
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "src\\file.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals,
        inspectTarget: async () => ({
          snapshot: facts(5),
          target: {
            requestedPath: "src\\file.txt",
            resolvedPath: "D:\\repo\\src\\file.txt",
            isDirectory: false,
            isSymbolicLink: false,
          },
        }),
        readBytes: async () => {
          reads += 1;
          return Buffer.from("hello");
        },
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.content, "hello");
    assert.equal(reads, 1);
    assert.equal(approvals.requests.length, 0);
  });

  it("does not read a sensitive target when approval is denied", async () => {
    const approvals = new RecordingApproval("denied");
    let reads = 0;
    let inspections = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: ".env.local",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals,
        inspectTarget: async () => {
          inspections += 1;
          return {
            snapshot: facts(5),
            target: {
              requestedPath: ".env.local",
              resolvedPath: "D:\\repo\\.env.local",
              isDirectory: false,
              isSymbolicLink: false,
            },
          };
        },
        readBytes: async () => {
          reads += 1;
          return Buffer.from("hello");
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "approval_denied" });
    assert.equal(reads, 0);
    assert.equal(inspections, 1);
    assert.equal(approvals.requests.length, 1);
    assert.match(approvals.requests[0]?.safePreview ?? "", /\.env\.local/u);
    assert.match(approvals.requests[0]?.safePreview ?? "", /20000 UTF-16/u);
  });

  it("reads a sensitive target after approval", async () => {
    const approvals = new RecordingApproval("approved");
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "..\\outside.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
        startLine: 1,
        lineCount: 1,
      },
      {
        approvals,
        inspectTarget: async () => ({
          snapshot: facts(8),
          target: {
            requestedPath: "..\\outside.txt",
            resolvedPath: "D:\\outside.txt",
            isDirectory: false,
            isSymbolicLink: false,
          },
        }),
        readBytes: async () => Buffer.from("outside\n"),
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.content, "outside\n");
    assert.equal(approvals.requests.length, 1);
  });

  it("rejects directory and symbolic-link targets before approval or read", async () => {
    const approvals = new RecordingApproval("approved");
    let reads = 0;
    const dependencies = {
      approvals,
      inspectTarget: async () => ({
        snapshot: facts(5),
        target: {
          requestedPath: directoryTarget ? "src\\" : "link.txt",
          resolvedPath: directoryTarget ? "D:\\repo\\src" : "D:\\repo\\target.txt",
          isDirectory: directoryTarget,
          isSymbolicLink: !directoryTarget,
        },
      }),
      readBytes: async () => {
        reads += 1;
        return Buffer.from("hello");
      },
    };

    let directoryTarget = true;
    const directory = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "src\\",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      dependencies,
    );
    assert.deepEqual(directory, { ok: false, code: "directory_target" });

    directoryTarget = false;
    const link = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "link.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      dependencies,
    );
    assert.deepEqual(link, { ok: false, code: "symbolic_link" });
    assert.equal(approvals.requests.length, 0);
    assert.equal(reads, 0);
  });

  it("stops on a file change during capture", async () => {
    let inspections = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "file.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => {
          inspections += 1;
          return {
            snapshot: inspections === 2 ? { ...facts(5), lastWriteTimeNs: 2n } : facts(5),
            target: {
              requestedPath: "file.txt",
              resolvedPath: "D:\\repo\\file.txt",
              isDirectory: false,
              isSymbolicLink: false,
            },
          };
        },
        readBytes: async () => Buffer.from("hello"),
      },
    );
    assert.deepEqual(result, { ok: false, code: "file_changed" });
  });

  it("does not reuse approval when resolved target changes before capture", async () => {
    let inspections = 0;
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: ".env.local",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => {
          inspections += 1;
          return {
            snapshot: facts(5),
            target: {
              requestedPath: ".env.local",
              resolvedPath: inspections === 1 ? "D:\\repo\\.env.local" : "D:\\outside\\.env.local",
              isDirectory: false,
              isSymbolicLink: false,
            },
          };
        },
        readBytes: async () => {
          reads += 1;
          return Buffer.from("hello");
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "precondition_changed" });
    assert.equal(reads, 0);
  });

  it("rejects a requested-path mismatch discovered during inspection", async () => {
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "safe.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => ({
          snapshot: facts(5),
          target: {
            requestedPath: "other.txt",
            resolvedPath: "D:\\repo\\other.txt",
            isDirectory: false,
            isSymbolicLink: false,
          },
        }),
        readBytes: async () => Buffer.from("hello"),
      },
    );
    assert.deepEqual(result, { ok: false, code: "precondition_changed" });
  });

  it("does not read when an approved target becomes a symbolic link", async () => {
    let inspections = 0;
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: ".env.local",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => {
          inspections += 1;
          return {
            snapshot: facts(5),
            target: {
              requestedPath: ".env.local",
              resolvedPath: "D:\\repo\\.env.local",
              isDirectory: false,
              isSymbolicLink: inspections > 1,
            },
          };
        },
        readBytes: async () => {
          reads += 1;
          return Buffer.from("hello");
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "precondition_changed" });
    assert.equal(inspections, 2);
    assert.equal(reads, 0);
  });

  it("does not read when an approved target becomes a directory", async () => {
    let inspections = 0;
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: ".env.local",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => {
          inspections += 1;
          return {
            snapshot: inspections > 1 ? { ...facts(5), isFile: false } : facts(5),
            target: {
              requestedPath: ".env.local",
              resolvedPath: "D:\\repo\\.env.local",
              isDirectory: inspections > 1,
              isSymbolicLink: false,
            },
          };
        },
        readBytes: async () => {
          reads += 1;
          return Buffer.from("hello");
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "precondition_changed" });
    assert.equal(inspections, 2);
    assert.equal(reads, 0);
  });

  it("rejects an oversized ordinary workspace file before reading", async () => {
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "large.txt",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => ({
          snapshot: facts(5 * 1024 * 1024 + 1),
          target: {
            requestedPath: "large.txt",
            resolvedPath: "D:\\repo\\large.txt",
            isDirectory: false,
            isSymbolicLink: false,
          },
        }),
        readBytes: async () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "file_too_large" });
    assert.equal(reads, 0);
  });

  it("rejects a non-regular ordinary workspace target before reading", async () => {
    let reads = 0;
    const result = await runReadFileFlow(
      {
        workspaceRoot: "D:\\repo",
        requestedPath: "special",
        snapshotId: "snapshot-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
      },
      {
        approvals: new RecordingApproval("approved"),
        inspectTarget: async () => ({
          snapshot: { ...facts(5), isFile: false },
          target: {
            requestedPath: "special",
            resolvedPath: "D:\\repo\\special",
            isDirectory: false,
            isSymbolicLink: false,
          },
        }),
        readBytes: async () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    );
    assert.deepEqual(result, { ok: false, code: "not_a_regular_file" });
    assert.equal(reads, 0);
  });
});
