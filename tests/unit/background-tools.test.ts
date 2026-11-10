import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKGROUND_START_DEFINITION,
  BACKGROUND_STATUS_DEFINITION,
  BACKGROUND_STOP_DEFINITION,
  type BackgroundToolDependencies,
  createBackgroundTools,
} from "../../src/adapters/tools/background-tools.ts";
import type { BackgroundTask, OutputRecord } from "../../src/domain/process/background.ts";

function record(index: number, stream: "stdout" | "stderr", text: string): OutputRecord {
  return {
    recordIndex: index,
    stream,
    streamByteStart: 0,
    byteLength: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: "task-1",
    processExecutionId: "exec-1",
    label: "build",
    state: "running",
    exitCode: null,
    records: [record(0, "stdout", "hello\n")],
    captureComplete: true,
    timedOut: false,
    ...overrides,
  };
}

type Fixture = {
  tool: ReturnType<typeof createBackgroundTools>;
  started: { command: string; environment: Readonly<Record<string, string>>; label: string }[];
  stopped: string[];
};

function fixture(
  options: {
    current?: BackgroundTask | null;
    startOutcome?: "started" | "unknown" | "throw";
    stopThrows?: boolean;
    sessionMode?: "read_only" | "workspace_write";
  } = {},
): Fixture {
  const started: Fixture["started"] = [];
  const stopped: string[] = [];
  const dependencies: BackgroundToolDependencies = {
    sessionMode: options.sessionMode ?? "workspace_write",
    inheritedEnvironment: { PATH: "C:\\Windows", ANTHROPIC_API_KEY: "secret" },
    startProcess: async (request, environment, label) => {
      started.push({ command: request.command, environment, label });
      if (options.startOutcome === "throw") throw new Error("spawn failed");
      if (options.startOutcome === "unknown") {
        return { kind: "unknown", safeCode: "spawn_outcome_unknown" };
      }
      return { kind: "started", task: task({ label: label || "task-1" }) };
    },
    getTask: async () => (options.current === undefined ? task() : options.current),
    stopTask: async (taskId) => {
      if (options.stopThrows === true) throw new Error("stop failed");
      stopped.push(taskId);
    },
  };
  return { tool: createBackgroundTools(dependencies), started, stopped };
}

describe("background tool definitions", () => {
  it("marks start and stop as approval-required, status and output as read-only", () => {
    const f = fixture();
    assert.equal(f.tool.getDefinition("background_start"), BACKGROUND_START_DEFINITION);
    assert.equal(f.tool.getDefinition("background_status"), BACKGROUND_STATUS_DEFINITION);
    assert.equal(f.tool.getDefinition("background_stop"), BACKGROUND_STOP_DEFINITION);
    assert.equal(BACKGROUND_START_DEFINITION.requiresApproval, true);
    assert.equal(BACKGROUND_STOP_DEFINITION.requiresApproval, true);
    assert.equal(BACKGROUND_STATUS_DEFINITION.requiresApproval, false);
    assert.equal(BACKGROUND_STATUS_DEFINITION.sideEffectClass, "read_only");
  });
});

describe("background_start", () => {
  it("starts a task with a filtered environment and reports only the launch", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_start",
      arguments: { command: "npm run watch", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.started[0]?.environment, { PATH: "C:\\Windows" });
    assert.match(result.text ?? "", /taskId=task-1/);
    assert.match(result.text ?? "", /timeoutMs=600000/);
    assert.match(result.text ?? "", /confirms start only, not completion or success/);
  });

  it("refuses to start in a read-only Session", async () => {
    const f = fixture({ sessionMode: "read_only" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_start",
      arguments: { command: "npm run watch", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "read_only_session", text: null });
    assert.equal(f.started.length, 0);
  });

  it("rejects an invalid label or timeout before spawning", async () => {
    const f = fixture();
    for (const args of [
      { command: "x", cwd: "D:\\repo", label: "   " },
      { command: "x", cwd: "D:\\repo", timeoutMs: 10 },
    ]) {
      const result = await f.tool.execute({
        toolCallId: "call-1",
        toolName: "background_start",
        arguments: args,
      });
      assert.equal(result.status, "failed");
    }
    assert.equal(f.started.length, 0);
  });

  it("reports an unknown spawn outcome without claiming a launch", async () => {
    const f = fixture({ startOutcome: "unknown" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_start",
      arguments: { command: "x", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "spawn_outcome_unknown",
    });
  });

  it("treats a throwing supervisor as unknown", async () => {
    const f = fixture({ startOutcome: "throw" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_start",
      arguments: { command: "x", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "background_start_unknown",
    });
  });
});

describe("background_status", () => {
  it("describes the task state", async () => {
    const f = fixture({ current: task({ state: "exited", exitCode: 0 }) });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_status",
      arguments: { taskId: "task-1" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /state=exited/);
    assert.match(result.text ?? "", /exitCode=0/);
  });

  it("reports an unknown task", async () => {
    const f = fixture({ current: null });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_status",
      arguments: { taskId: "missing" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "unknown_task", text: null });
  });
});

describe("background_output", () => {
  it("returns a page with stream provenance and a next cursor", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_output",
      arguments: { taskId: "task-1" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /\[stdout@0\] hello/);
    assert.match(result.text ?? "", /caughtUp=true/);
    assert.match(result.text ?? "", /taskEnded=false/);
    assert.match(result.text ?? "", /captureComplete=true/);
    assert.match(result.text ?? "", /nextCursor=1:0/);
  });

  it("rejects a cursor that belongs to another task", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_output",
      arguments: {
        taskId: "task-1",
        cursor: {
          taskId: "other-task",
          processExecutionId: "exec-1",
          recordIndex: 0,
          recordByteOffset: 0,
        },
      },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "cursor_task_mismatch",
      text: null,
    });
  });

  it("rejects an invalid page size", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_output",
      arguments: { taskId: "task-1", pageBytes: 0 },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "invalid_arguments", text: null });
  });
});

describe("background_stop", () => {
  it("requests supervised termination of a running task", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_stop",
      arguments: { taskId: "task-1" },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.stopped, ["task-1"]);
    assert.match(result.text ?? "", /requested supervised termination/);
  });

  it("refuses to stop a task that already ended", async () => {
    const f = fixture({ current: task({ state: "exited", exitCode: 0 }) });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_stop",
      arguments: { taskId: "task-1" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "task_not_terminal", text: null });
    assert.equal(f.stopped.length, 0);
  });

  it("reports an unknown stop outcome", async () => {
    const f = fixture({ stopThrows: true });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "background_stop",
      arguments: { taskId: "task-1" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "background_stop_unknown",
    });
  });
});

describe("background previews", () => {
  it("shows the normalized timeout and no-sandbox statement for start", async () => {
    const f = fixture();
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "background_start",
      arguments: { command: "npm run watch", cwd: "D:\\repo" },
    });
    assert.match(preview ?? "", /timeoutMs=600000/);
    assert.match(preview ?? "", /sandbox=none/);
    assert.equal(f.started.length, 0);
  });

  it("states the supervised-termination effect for stop", async () => {
    const f = fixture();
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "background_stop",
      arguments: { taskId: "task-1" },
    });
    assert.match(preview ?? "", /taskId=task-1/);
    assert.match(preview ?? "", /supervised termination/);
  });
});
