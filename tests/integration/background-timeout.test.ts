import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createBackgroundRegistry } from "../../src/adapters/windows/background-registry.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-bgto-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function registry() {
  return createBackgroundRegistry({
    sessionMode: "workspace_write",
    // The child no longer inherits the parent environment, so the test supplies
    // what it needs explicitly. An empty environment would leave `ping` with no
    // PATH, which is a different failure than the timeout under test.
    inheritedEnvironment: {
      PATH: process.env["PATH"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      COMSPEC: process.env["COMSPEC"] ?? "",
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The environment the real tool layer passes: the result of
 * `filterChildEnvironment`. Supplying an empty object here would strip PATH and
 * make the child fail for a reason unrelated to the timeout under test.
 */
const CHILD_ENV: Readonly<Record<string, string>> = {
  PATH: process.env["PATH"] ?? "",
  SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
  COMSPEC: process.env["COMSPEC"] ?? "",
};

async function start(reg: ReturnType<typeof registry>, timeoutMs: number) {
  const result = await reg.dependencies.startProcess(
    {
      command: "Write-Output 'started'; Start-Sleep -Seconds 60",
      cwd: root,
      timeoutMs,
      environmentGrants: [],
    },
    CHILD_ENV,
    "long",
  );
  assert.equal(result.kind, "started");
  if (result.kind !== "started") throw new Error("start failed");
  return result.task.taskId;
}

describe("background task timeout", () => {
  it("stops a task when its deadline passes, even without polling", async () => {
    const reg = registry();
    const taskId = await start(reg, 1_500);

    const before = await reg.dependencies.getTask(taskId);
    assert.equal(before?.state, "running");
    assert.equal(before?.timedOut, false);

    await sleep(2_500);

    const after = await reg.dependencies.getTask(taskId);
    assert.equal(after?.state, "stopped");
    assert.equal(after?.timedOut, true);
    reg.disposeAll();
  });

  it("keeps the partial output of a timed-out task", async () => {
    const reg = registry();
    try {
      // Cold PowerShell startup under the full parallel suite can exceed 1.5s.
      // Observe the prefix before testing its retention at the actual deadline.
      const taskId = await start(reg, 5_000);
      const end = Date.now() + 8_000;
      let task = await reg.dependencies.getTask(taskId);
      while (
        task?.state === "running" &&
        !task.records.some((record) => record.text.includes("started"))
      ) {
        assert.ok(Date.now() < end, "background output observation timed out");
        await sleep(50);
        task = await reg.dependencies.getTask(taskId);
      }
      assert.ok(
        task?.records.some((record) => record.text.includes("started")),
        "the process produced the prefix",
      );
      while (task?.state === "running") {
        assert.ok(Date.now() < end, "background termination timed out");
        await sleep(50);
        task = await reg.dependencies.getTask(taskId);
      }
      assert.equal(task?.timedOut, true);
      assert.equal(
        task?.records.some((record) => record.text.includes("started")),
        true,
      );
    } finally {
      reg.disposeAll();
    }
  });

  it("does not mark a task that finished in time as timed out", async () => {
    const reg = registry();
    try {
      const result = await reg.dependencies.startProcess(
        { command: "echo quick", cwd: root, timeoutMs: 10_000, environmentGrants: [] },
        CHILD_ENV,
        "quick",
      );
      assert.equal(result.kind, "started");
      if (result.kind !== "started") return;

      const deadline = Date.now() + 10_000;
      let task = await reg.dependencies.getTask(result.task.taskId);
      while (task?.state === "running" && Date.now() < deadline) {
        await sleep(50);
        task = await reg.dependencies.getTask(result.task.taskId);
      }
      assert.equal(task?.state, "exited");
      assert.equal(task?.timedOut, false);
    } finally {
      reg.disposeAll();
    }
  });

  it("clears the timer when a task is stopped explicitly", async () => {
    const reg = registry();
    const taskId = await start(reg, 30_000);

    await reg.dependencies.stopTask(taskId);
    const task = await reg.dependencies.getTask(taskId);
    assert.equal(task?.state, "stopped");
    assert.equal(task?.timedOut, false);
    reg.disposeAll();
  });
});
