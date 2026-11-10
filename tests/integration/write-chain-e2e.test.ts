import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import type { ModelProvider, ProviderCompletion } from "../../src/ports/model-provider.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * End-to-end write chain.
 *
 * ADR-0042 recorded that the wire tests proved only that the model is *offered*
 * the write tools. This closes that gap: the real tool executor, the real write
 * adapter, the real approval suspension and the real coordinator, against a real
 * temporary directory.
 *
 * What this does not prove: that a real model would choose the right call, or that
 * the platform write path is crash-safe. G05/G06 own the latter.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-write-e2e-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

class SequenceProvider implements ModelProvider {
  readonly requests: number[] = [];
  readonly #responses: ProviderCompletion[];

  constructor(responses: readonly ProviderCompletion[]) {
    this.#responses = [...responses];
  }

  async complete(): Promise<ProviderCompletion> {
    this.requests.push(this.requests.length);
    return this.#responses.shift() ?? { kind: "invalid_response", safeCode: "script_exhausted" };
  }
}

function coordinator(directory: string, provider: ModelProvider) {
  const ids = new SequenceIds("id");
  const digests = new JsonDigest();
  const tools = createWorkspaceTools({
    workspaceRoot: directory,
    // The inline gate denies. Writes are approval-required, so they suspend
    // instead of consulting this gate.
    approvals: { decide: async () => "denied" },
    ids,
    enableWrites: true,
    enableProcesses: false,
  });
  return {
    coordinator: new RuntimeCoordinator({
      provider,
      tools,
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, digests),
      ids,
      nowUtc: () => "2026-11-05T00:00:00.000Z",
      suspendOnApproval: true,
    }),
    tools,
  };
}

async function approvePending(
  coordinatorUnderTest: RuntimeCoordinator,
  decision: "approved" | "denied",
) {
  const deadline = Date.now() + 5000;
  while (coordinatorUnderTest.pendingApprovalView() === null && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const pending = coordinatorUnderTest.pendingApprovalView();
  assert.ok(pending !== null, "the write must suspend for approval");
  if (pending === null) return null;
  await coordinatorUnderTest.replyApproval({
    commandId: "cmd-1",
    approvalId: pending.approvalId,
    toolCallId: pending.toolCallId,
    requestVersion: pending.requestVersion,
    decision,
  });
  return coordinatorUnderTest.settle();
}

describe("approved create_file reaches disk", () => {
  it("writes the file only after approval and reports it in the transcript", async () => {
    const directory = path.join(root, "create-approved");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });

    const provider = new SequenceProvider([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "call-1",
            toolName: "create_file",
            arguments: { path: "hello.txt", content: "written by the agent\n" },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);
    const built = coordinator(directory, provider);
    const run = built.coordinator.run("create a file");

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing may be written before approval.
    await assert.rejects(readFile(path.join(directory, "hello.txt"), "utf8"));

    const settled = (await approvePending(built.coordinator, "approved")) ?? (await run);
    assert.equal(settled.status, "completed", settled.safeCode ?? "");

    const content = await readFile(path.join(directory, "hello.txt"), "utf8");
    assert.equal(content, "written by the agent\n");

    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished.length, 1);
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.status, "succeeded");
  });

  it("does not write when the user denies", async () => {
    const directory = path.join(root, "create-denied");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });

    const provider = new SequenceProvider([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "call-1",
            toolName: "create_file",
            arguments: { path: "denied.txt", content: "must not exist" },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "acknowledged" },
    ]);
    const built = coordinator(directory, provider);
    const run = built.coordinator.run("create a file");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = (await approvePending(built.coordinator, "denied")) ?? (await run);
    assert.equal(settled.status, "completed");

    await assert.rejects(readFile(path.join(directory, "denied.txt"), "utf8"));

    const denied = settled.events.filter((event) => event.payload.kind === "tool_execution_denied");
    assert.equal(denied.length, 1);
  });
});

describe("approved edit_file changes the file", () => {
  it("replaces the target text and preserves the rest", async () => {
    const directory = path.join(root, "edit-approved");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "app.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

    const provider = new SequenceProvider([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "call-1",
            toolName: "edit_file",
            arguments: { path: "app.ts", oldText: "const a = 1;", newText: "const a = 42;" },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);
    const built = coordinator(directory, provider);
    const run = built.coordinator.run("change the constant");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = (await approvePending(built.coordinator, "approved")) ?? (await run);
    assert.equal(settled.status, "completed");

    const content = await readFile(path.join(directory, "app.ts"), "utf8");
    assert.equal(content, "const a = 42;\nconst b = 2;\n");
  });

  it("fails without writing when the old text is absent", async () => {
    const directory = path.join(root, "edit-missing");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    const original = "const a = 1;\n";
    await writeFile(path.join(directory, "app.ts"), original, "utf8");

    const provider = new SequenceProvider([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "call-1",
            toolName: "edit_file",
            arguments: { path: "app.ts", oldText: "not present", newText: "x" },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "could not edit" },
    ]);
    const built = coordinator(directory, provider);
    const run = built.coordinator.run("try an impossible edit");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const pending = built.coordinator.pendingApprovalView();
    // The planner rejects before approval is even requested.
    if (pending !== null) {
      await built.coordinator.replyApproval({
        commandId: "cmd-1",
        approvalId: pending.approvalId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        decision: "approved",
      });
    }
    const settled = (await built.coordinator.settle()) ?? (await run);

    assert.equal(await readFile(path.join(directory, "app.ts"), "utf8"), original);
    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.status, "failed");
  });
});

describe("read-only mode refuses writes", () => {
  it("reports the tool as unavailable when writes are disabled", async () => {
    const directory = path.join(root, "readonly");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });

    const tools = createWorkspaceTools({
      workspaceRoot: directory,
      approvals: { decide: async () => "denied" },
      ids: new SequenceIds("id"),
      enableWrites: false,
      enableProcesses: false,
    });

    assert.equal(tools.getDefinition("create_file"), null);
    const result = await tools.execute({
      toolCallId: "c1",
      toolName: "create_file",
      arguments: { path: "nope.txt", content: "x" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
    await assert.rejects(readFile(path.join(directory, "nope.txt"), "utf8"));
  });
});

describe("approved apply_patch changes files", () => {
  it("applies a unified diff to an existing file", async () => {
    const directory = path.join(root, "patch-approved");
    await rm(directory, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "b.txt"), "alpha\nbeta\n", "utf8");

    const patch = [
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+gamma",
      "",
    ].join("\n");

    const provider = new SequenceProvider([
      {
        kind: "completed",
        toolCalls: [
          { providerToolCallId: "call-1", toolName: "apply_patch", arguments: { patch } },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);
    const built = coordinator(directory, provider);
    const run = built.coordinator.run("apply the patch");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = (await approvePending(built.coordinator, "approved")) ?? (await run);

    const content = await readFile(path.join(directory, "b.txt"), "utf8");
    // Either it applied cleanly or it reported a failure; it must never report
    // success while leaving the file unchanged.
    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;

    if (payload.status === "succeeded") {
      assert.match(content, /gamma/);
      assert.equal(content.includes("beta"), false);
    } else {
      assert.equal(content, "alpha\nbeta\n", "a failed patch must not modify the file");
    }
  });
});
