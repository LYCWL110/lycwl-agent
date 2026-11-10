import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

class DenyingGate implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];

  async decide(request: ApprovalRequest): Promise<"approved" | "denied"> {
    this.requests.push(request);
    return "denied";
  }
}

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-write-"));
  await mkdir(path.join(root, "src"), { recursive: true });
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

describe("create_file on real disk", () => {
  it("creates a new file with the planned bytes", async () => {
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "src/new.ts", content: "export const a = 1;\n" },
    });

    assert.equal(result.status, "succeeded");
    const actual = await readFile(path.join(root, "src", "new.ts"), "utf8");
    assert.equal(actual, "export const a = 1;\n");
  });

  it("refuses to overwrite an existing file", async () => {
    await writeFile(path.join(root, "src", "exists.ts"), "original\n");
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "src/exists.ts", content: "replaced\n" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "file_conflict", text: null });
    assert.equal(await readFile(path.join(root, "src", "exists.ts"), "utf8"), "original\n");
  });

  it("leaves no temp file behind after a successful create", async () => {
    const t = tools();
    await t.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "src/clean.ts", content: "x\n" },
    });
    const names = await readdir(path.join(root, "src"));
    assert.equal(
      names.some((name) => name.endsWith(".tmp")),
      false,
    );
  });
});

describe("edit_file on real disk", () => {
  it("preserves CRLF and surrounding bytes", async () => {
    await writeFile(path.join(root, "src", "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "edit_file",
      arguments: { path: "src/crlf.txt", oldText: "two", newText: "TWO" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(
      await readFile(path.join(root, "src", "crlf.txt"), "utf8"),
      "one\r\nTWO\r\nthree\r\n",
    );
  });

  it("preserves a UTF-16LE BOM", async () => {
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]);
    await writeFile(path.join(root, "src", "u16.txt"), bom);
    const t = tools();

    const result = await t.execute({
      toolCallId: "c1",
      toolName: "edit_file",
      arguments: { path: "src/u16.txt", oldText: "hi", newText: "hello" },
    });

    assert.equal(result.status, "succeeded");
    const bytes = await readFile(path.join(root, "src", "u16.txt"));
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(bytes.subarray(2).toString("utf16le").replace(/\r\n/g, "\n"), "hello\n");
  });

  it("writes nothing when the match is ambiguous", async () => {
    await writeFile(path.join(root, "src", "dup.txt"), "x\nx\n");
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "edit_file",
      arguments: { path: "src/dup.txt", oldText: "x", newText: "y" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "match_ambiguous", text: null });
    assert.equal(await readFile(path.join(root, "src", "dup.txt"), "utf8"), "x\nx\n");
  });

  it("refuses a missing target", async () => {
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "edit_file",
      arguments: { path: "src/missing.txt", oldText: "a", newText: "b" },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "not_found", text: null });
  });
});

describe("apply_patch on real disk", () => {
  it("applies two targets serially", async () => {
    await writeFile(path.join(root, "src", "p1.txt"), "alpha\n");
    await writeFile(path.join(root, "src", "p2.txt"), "beta\n");
    const diff = [
      "--- a/src/p1.txt",
      "+++ b/src/p1.txt",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
      "--- a/src/p2.txt",
      "+++ b/src/p2.txt",
      "@@ -1,1 +1,1 @@",
      "-beta",
      "+BETA",
    ].join("\n");

    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "apply_patch",
      arguments: { patch: diff },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(await readFile(path.join(root, "src", "p1.txt"), "utf8"), "ALPHA\n");
    assert.equal(await readFile(path.join(root, "src", "p2.txt"), "utf8"), "BETA\n");
  });

  it("refuses the batch when a context line does not match", async () => {
    await writeFile(path.join(root, "src", "p3.txt"), "DIFFERENT\n");
    const diff = [
      "--- a/src/p3.txt",
      "+++ b/src/p3.txt",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
    ].join("\n");

    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "apply_patch",
      arguments: { patch: diff },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "context_mismatch", text: null });
    assert.equal(await readFile(path.join(root, "src", "p3.txt"), "utf8"), "DIFFERENT\n");
  });
});

describe("write safety on real disk", () => {
  it("refuses a path that escapes the workspace", async () => {
    const t = tools();
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "..\\..\\escape.txt", content: "x" },
    });
    assert.equal(result.status, "failed");
    const finished = result.status === "failed" ? result.safeCode : "";
    assert.equal(finished === "invalid_path" || finished === "file_conflict", true);
  });

  it("requires approval for .env through the Runtime and writes nothing when denied", async () => {
    // Approval is a Runtime responsibility: calling the tool executor directly
    // would bypass it, so this case goes through a real coordinator.
    const ids = new SequenceIds("write");
    const digests = new JsonDigest();
    const eventLog = new InMemoryEventLog(ids, digests);
    const denying = new DenyingGate();
    const coordinator = new RuntimeCoordinator({
      provider: new ScriptedProvider([
        {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: "p1",
              toolName: "create_file",
              arguments: { path: ".env", content: "SECRET=1\n" },
            },
          ],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "reported" },
      ]),
      tools: createWorkspaceTools({
        workspaceRoot: root,
        approvals: denying,
        ids,
        enableWrites: true,
      }),
      approvals: denying,
      eventLog,
      ids,
      nowUtc: () => "2026-11-02T00:00:00.000Z",
      sleep: async () => undefined,
    });

    const result = await coordinator.run("write a secret");

    assert.equal(denying.requests.length, 1);
    assert.notEqual(
      result.events.find((event) => event.payload.kind === "tool_execution_denied"),
      undefined,
    );
    const exists = await readFile(path.join(root, ".env"), "utf8").catch(() => null);
    assert.equal(exists, null);
  });

  it("keeps writes disabled when the build is read-only", async () => {
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "id" },
      enableWrites: false,
    });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "src/nope.ts", content: "x" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
  });

  it("still fails closed for shell, background, LSP and web", async () => {
    const t = tools();
    for (const toolName of ["shell", "background_start", "lsp_diagnostics", "web_fetch"]) {
      const result = await t.execute({
        toolCallId: "c1",
        toolName,
        arguments: { command: "x", url: "https://e.com" },
      });
      assert.deepEqual(result, {
        status: "failed",
        safeCode: "tool_unavailable_in_build",
        text: null,
      });
    }
  });
});
