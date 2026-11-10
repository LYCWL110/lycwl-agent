import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-bg-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function tools() {
  return createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "approved" },
    ids: { create: () => "id" },
    enableWrites: true,
    enableProcesses: true,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(t: ReturnType<typeof tools>, taskId: string) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const status = await t.execute({
      toolCallId: "observe",
      toolName: "background_status",
      arguments: { taskId },
    });
    if (/state=exited/.test(status.text ?? "")) return status;
    assert.equal(status.status, "succeeded");
    assert.ok(Date.now() < deadline, "background command did not exit");
    await sleep(25);
  }
}

describe("background tools on real processes", () => {
  it("starts a task and reports only that the launch was accepted", async () => {
    const t = tools();
    const started = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: { command: "Start-Sleep -Seconds 6", cwd: root, label: "wait" },
    });

    assert.equal(started.status, "succeeded");
    assert.match(started.text ?? "", /taskId=task-1/);
    assert.match(started.text ?? "", /confirms start only/);

    const taskId = /taskId=(\S+)/.exec(started.text ?? "")?.[1] ?? "";
    await t.execute({ toolCallId: "c2", toolName: "background_stop", arguments: { taskId } });
  });

  it("reports status and output for a finished task", async () => {
    const t = tools();
    const started = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: { command: "echo background-done", cwd: root },
    });
    const taskId = /taskId=(\S+)/.exec(started.text ?? "")?.[1] ?? "";
    assert.notEqual(taskId, "");

    const status = await waitForExit(t, taskId);
    assert.equal(status.status, "succeeded");
    assert.match(status.text ?? "", /state=exited/);

    const output = await t.execute({
      toolCallId: "c3",
      toolName: "background_output",
      arguments: { taskId },
    });
    assert.equal(output.status, "succeeded");
    assert.match(output.text ?? "", /background-done/);
    assert.match(output.text ?? "", /\[stdout@0\]/);
  });

  it("stops a running task and marks it stopped", async () => {
    const t = tools();
    const started = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: { command: "Start-Sleep -Seconds 60", cwd: root },
    });
    const taskId = /taskId=(\S+)/.exec(started.text ?? "")?.[1] ?? "";

    const stopped = await t.execute({
      toolCallId: "c2",
      toolName: "background_stop",
      arguments: { taskId },
    });
    assert.equal(stopped.status, "succeeded");

    const status = await t.execute({
      toolCallId: "c3",
      toolName: "background_status",
      arguments: { taskId },
    });
    assert.match(status.text ?? "", /state=stopped|state=exited/);
  });

  it("refuses to stop a task that already ended", async () => {
    const t = tools();
    const started = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: { command: "echo quick", cwd: root },
    });
    const taskId = /taskId=(\S+)/.exec(started.text ?? "")?.[1] ?? "";
    await waitForExit(t, taskId);

    const stopped = await t.execute({
      toolCallId: "c2",
      toolName: "background_stop",
      arguments: { taskId },
    });
    assert.equal(stopped.status, "failed");
    if (stopped.status !== "failed") return;
    assert.equal(stopped.safeCode, "task_not_terminal");
  });

  it("reports an unknown task id", async () => {
    const t = tools();
    for (const toolName of ["background_status", "background_output", "background_stop"]) {
      const result = await t.execute({
        toolCallId: "c1",
        toolName,
        arguments: { taskId: "does-not-exist" },
      });
      assert.deepEqual(result, { status: "failed", safeCode: "unknown_task", text: null });
    }
  });

  it("resumes from the returned cursor without re-delivering old bytes", async () => {
    const t = tools();
    const started = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: {
        command: "Write-Output 'first'; Start-Sleep -Seconds 2; Write-Output 'second'",
        cwd: root,
      },
    });
    const taskId = /taskId=(\S+)/.exec(started.text ?? "")?.[1] ?? "";

    const initial = {
      toolCallId: "c2",
      toolName: "background_output",
      arguments: { taskId, pageBytes: 7 },
    };
    try {
      const end = Date.now() + 10_000;
      let early = await t.execute(initial);
      while (!(early.text ?? "").includes("[stdout@0] first")) {
        assert.ok(Date.now() < end, "first output was not observed");
        await sleep(50);
        early = await t.execute(initial);
      }
      assert.equal(early.status, "succeeded");
      const processExecutionId = /processExecutionId=([^;\s]+)/.exec(early.text ?? "")?.[1];
      const position = /nextCursor=(\d+):(\d+)/.exec(early.text ?? "");
      assert.ok(processExecutionId && position);
      const cursor = {
        taskId,
        processExecutionId,
        recordIndex: Number(position[1]),
        recordByteOffset: Number(position[2]),
      };
      const next = {
        toolCallId: "c3",
        toolName: "background_output",
        arguments: { taskId, cursor },
      };
      let response = await t.execute(next);
      while (!(response.text ?? "").includes("second")) {
        assert.ok(Date.now() < end, "second output was not observed");
        await sleep(50);
        response = await t.execute(next);
      }
      assert.equal(response.status, "succeeded");
      const body = (response.text ?? "").split("\n").slice(1).join("\n");
      assert.equal(body.includes("first"), false, "cursor does not redeliver the first page");
      const repeated = await t.execute(initial);
      assert.equal(
        (repeated.text ?? "").split("\n").slice(1).join("\n"),
        (early.text ?? "").split("\n").slice(1).join("\n"),
        "published bytes remain stable after more output arrives",
      );
    } finally {
      await t.cancelAll?.();
    }
  });
  it("stays unavailable when processes are disabled", async () => {
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "id" },
      enableWrites: true,
      enableProcesses: false,
    });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "background_start",
      arguments: { command: "echo x", cwd: root },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
  });
});
