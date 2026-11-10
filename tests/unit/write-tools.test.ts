import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CREATE_FILE_DEFINITION,
  createWriteTools,
  EDIT_FILE_DEFINITION,
  type WriteTargetFacts,
  type WriteToolDependencies,
} from "../../src/adapters/tools/write-tools.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class RecordingApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];

  async decide(request: ApprovalRequest): Promise<"approved" | "denied"> {
    this.requests.push(request);
    return "approved";
  }
}

type Fixture = {
  approvals: RecordingApproval;
  writes: { path: string; bytes: Uint8Array }[];
  setFile: (path: string, content: string | null) => void;
  inspectTarget: WriteToolDependencies["inspectTarget"];
  readBytes: WriteToolDependencies["readBytes"];
  writeBytes: WriteToolDependencies["writeBytes"];
};

function fixture(initial: Record<string, string> = {}): Fixture {
  const files = new Map<string, Buffer>();
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, Buffer.from(content, "utf8"));
  }
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const approvals = new RecordingApproval();
  return {
    approvals,
    writes,
    setFile: (path, content) => {
      if (content === null) files.delete(path);
      else files.set(path, Buffer.from(content, "utf8"));
    },
    inspectTarget: async (path): Promise<WriteTargetFacts> => {
      const bytes = files.get(path);
      return bytes === undefined
        ? { exists: false, sha256: null }
        : { exists: true, sha256: sha(bytes) };
    },
    readBytes: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("not found");
      return bytes;
    },
    writeBytes: async (path, bytes) => {
      writes.push({ path, bytes });
      files.set(path, Buffer.from(bytes));
    },
  };
}

describe("write tool definitions", () => {
  it("declares both tools as approval-required filesystem mutations", () => {
    const tools = createWriteTools(fixture());
    for (const definition of [CREATE_FILE_DEFINITION, EDIT_FILE_DEFINITION]) {
      assert.equal(tools.getDefinition(definition.name), definition);
      assert.equal(definition.sideEffectClass, "filesystem_mutation");
      assert.equal(definition.requiresApproval, true);
    }
    assert.equal(tools.getDefinition("read_file"), null);
  });
});

describe("create_file execution", () => {
  it("writes a new file with the planned bytes", async () => {
    const deps = fixture();
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "create_file",
      arguments: { path: "notes.txt", content: "hello\n" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(deps.writes.length, 1);
    assert.equal(Buffer.from(deps.writes[0]?.bytes ?? []).toString("utf8"), "hello\n");
    assert.match(result.text ?? "", /create_file: notes\.txt/);
  });

  it("refuses to overwrite an existing file", async () => {
    const deps = fixture({ "notes.txt": "existing" });
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "create_file",
      arguments: { path: "notes.txt", content: "new" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "file_conflict", text: null });
    assert.equal(deps.writes.length, 0);
  });

  it("rejects the legacy preserve line ending before any write", async () => {
    const deps = fixture();
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "create_file",
      arguments: { path: "a.txt", content: "x", lineEnding: "preserve" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "preserve_rejected", text: null });
    assert.equal(deps.writes.length, 0);
  });
});

describe("edit_file execution", () => {
  it("replaces a unique match and reports the new hash", async () => {
    const deps = fixture({ "src.ts": "const a = 1;\n" });
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "edit_file",
      arguments: {
        path: "src.ts",
        oldText: "const a = 1;",
        newText: "const a = 2;",
      },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(deps.writes.length, 1);
    assert.equal(Buffer.from(deps.writes[0]?.bytes ?? []).toString("utf8"), "const a = 2;\n");
    assert.match(result.text ?? "", /replacedOccurrences=1/);
  });

  it("fails when the target does not exist", async () => {
    const deps = fixture();
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "edit_file",
      arguments: { path: "missing.ts", oldText: "a", newText: "b" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "not_found", text: null });
    assert.equal(deps.writes.length, 0);
  });

  it("refuses an ambiguous match without writing", async () => {
    const deps = fixture({ "dup.ts": "x\nx\n" });
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "edit_file",
      arguments: { path: "dup.ts", oldText: "x", newText: "y" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "match_ambiguous", text: null });
    assert.equal(deps.writes.length, 0);
  });

  it("stops when the target changes between planning and write", async () => {
    const deps = fixture({ "src.ts": "a\n" });
    const tools = createWriteTools(deps);
    let reads = 0;
    const originalRead = deps.readBytes;
    deps.readBytes = async (path) => {
      reads += 1;
      const bytes = await originalRead(path);
      if (reads === 1) deps.setFile("src.ts", "changed externally\n");
      return bytes;
    };

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "edit_file",
      arguments: { path: "src.ts", oldText: "a", newText: "b" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "file_conflict", text: null });
    assert.equal(deps.writes.length, 0);
  });

  it("reports outcome_unknown when the write sink throws", async () => {
    const deps = fixture({ "src.ts": "a\n" });
    deps.writeBytes = async () => {
      throw new Error("disk error");
    };
    const tools = createWriteTools(deps);

    const result = await tools.execute({
      toolCallId: "call-1",
      toolName: "edit_file",
      arguments: { path: "src.ts", oldText: "a", newText: "b" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "write_outcome_unknown",
    });
  });
});

describe("write previews", () => {
  it("renders the exact target and format facts", async () => {
    const deps = fixture();
    const tools = createWriteTools(deps);

    const preview = await tools.preview?.({
      toolCallId: "call-1",
      toolName: "create_file",
      arguments: { path: "notes.txt", content: "hello\n" },
    });

    assert.match(preview ?? "", /create_file/);
    assert.match(preview ?? "", /path=notes\.txt/);
    assert.match(preview ?? "", /encoding=utf-8/);
    assert.match(preview ?? "", /lineEnding=lf/);
    assert.match(preview ?? "", /effect=replaces file bytes on disk/);
    assert.equal(deps.writes.length, 0);
  });

  it("shows the planning failure instead of a preview", async () => {
    const deps = fixture({ "notes.txt": "exists" });
    const tools = createWriteTools(deps);

    const preview = await tools.preview?.({
      toolCallId: "call-1",
      toolName: "create_file",
      arguments: { path: "notes.txt", content: "new" },
    });

    assert.equal(preview, "create_file: file_conflict");
  });
});
