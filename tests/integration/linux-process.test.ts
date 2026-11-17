import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBackgroundRegistry } from "../../src/adapters/linux/background-registry.ts";
import { createProcessSupervisor } from "../../src/adapters/linux/process-supervisor.ts";
import { acquireExclusiveFileLease } from "../../src/adapters/platform-file-lease.ts";
import { MAX_CAPTURE_BYTES } from "../../src/adapters/windows/bounded-process-output.ts";

const environment = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

describe("Linux process lifecycle", { skip: process.platform !== "linux" }, () => {
  it("keeps bounded UTF-8 output and raw evidence on timeout and cancellation", async () => {
    const supervisor = createProcessSupervisor();
    const result = await supervisor.runToCompletion({
      command: "printf '中文-before-timeout'; sleep 30",
      cwd: process.cwd(),
      environment,
      timeoutMs: 400,
    });
    assert.equal(result.kind, "completed");
    if (result.kind === "completed") {
      assert.equal(result.timedOut, true);
      assert.equal(result.stdout, "中文-before-timeout");
      assert.equal(result.captureComplete, true);
      assert.equal(Buffer.from(result.rawOutput?.stdout ?? []).toString(), result.stdout);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    try {
      const cancelled = await supervisor.runToCompletion({
        command: "printf before-cancel; sleep 30",
        cwd: process.cwd(),
        environment,
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      assert.equal(cancelled.kind, "completed");
      if (cancelled.kind === "completed") {
        assert.equal(cancelled.cancelled, true);
        assert.equal(cancelled.timedOut, false);
        assert.equal(cancelled.stdout, "before-cancel");
      }
    } finally {
      clearTimeout(timer);
    }
  });

  it("bounds output and blocks protected keys", async () => {
    const supervisor = createProcessSupervisor();
    const limited = await supervisor.runToCompletion({
      command: `head -c ${MAX_CAPTURE_BYTES + 1000} /dev/zero | tr '\\0' x`,
      cwd: process.cwd(),
      environment,
      timeoutMs: 5_000,
    });
    assert.equal(limited.kind, "completed");
    if (limited.kind === "completed") {
      assert.equal(limited.outputLimitExceeded, true);
      assert.equal(limited.captureComplete, false);
      assert.ok(limited.rawBytes <= MAX_CAPTURE_BYTES + 1);
    }
    const guarded = createProcessSupervisor({
      ownedKeys: {
        keys: [
          {
            keyId: "test",
            value: "SYNTHETIC_LINUX_PROTECTED_VALUE",
            state: "sending",
            revision: 1,
          },
        ],
      },
    });
    const blocked = await guarded.runToCompletion({
      command: "printf SYNTHETIC_LINUX_PROTECTED_VALUE",
      cwd: process.cwd(),
      environment,
      timeoutMs: 5_000,
    });
    assert.equal(blocked.kind, "completed");
    if (blocked.kind === "completed") {
      assert.equal(blocked.deliveryBlocked, "owned_key_detected");
      assert.equal(blocked.stdout, "");
      assert.equal(blocked.rawOutput, undefined);
    }
  });

  it("reports command signals and fails before launching in a missing cwd", async () => {
    const supervisor = createProcessSupervisor();
    const signalled = await supervisor.runToCompletion({
      command: "kill -INT $$",
      cwd: process.cwd(),
      environment,
      timeoutMs: 5_000,
    });
    assert.equal(signalled.kind === "completed" && signalled.exitCode, 130);
    const absent = await supervisor.runToCompletion({
      command: "printf must-not-run",
      cwd: `/tmp/lycwl-absent-${process.pid}`,
      environment,
      timeoutMs: 500,
    });
    assert.deepEqual(absent, { kind: "failed", code: "process_create_failed" });
  });

  it("releases a process-owned lock after the owner is killed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-lock-owner-"));
    const target = path.join(root, "owner.lock");
    const source = `
      import { acquireExclusiveFileLease } from ${JSON.stringify(new URL("../../src/adapters/platform-file-lease.ts", import.meta.url).href)};
      await acquireExclusiveFileLease(${JSON.stringify(target)});
      process.stdout.write("owned");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      assert.ok(child.stdout);
      const ready = await Promise.race([
        once(child.stdout, "data").then(([value]) => String(value)),
        once(child, "exit").then(() => "exited"),
      ]);
      assert.equal(ready, "owned");
      await assert.rejects(acquireExclusiveFileLease(target, { timeoutMs: 0 }), /lock_busy/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const recovered = await acquireExclusiveFileLease(target, { timeoutMs: 0 });
      recovered.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates supervised descendants when the Harness exits abruptly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-linux-watchdog-"));
    const pidFile = path.join(root, "child.pid");
    const source = `
      import { createProcessSupervisor } from ${JSON.stringify(new URL("../../src/adapters/linux/process-supervisor.ts", import.meta.url).href)};
      const supervisor = createProcessSupervisor();
      const started = supervisor.start({ command: 'echo $$ > child.pid; exec sleep 30', cwd: ${JSON.stringify(root)}, environment: ${JSON.stringify(environment)}, executionId: 'crash-test' });
      if (!started.ok) process.exit(1);
      process.stdout.write("started");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      assert.ok(child.stdout);
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error("Harness exited before start");
        }),
      ]);
      let pid = 0;
      for (let n = 0; n < 100; n++) {
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (pid) break;
        await delay(20);
      }
      assert.ok(pid > 1);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      let active = true;
      for (let n = 0; n < 100; n++) {
        const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        active = status !== "" && !/^\d+ \(.*\) Z /.test(status);
        if (!active) break;
        await delay(20);
      }
      assert.equal(active, false, "supervised descendant must not keep running");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes background stop and observation while retaining final output", async () => {
    const registry = createBackgroundRegistry({
      sessionMode: "workspace_write",
      inheritedEnvironment: environment,
    });
    try {
      const started = await registry.dependencies.startProcess(
        {
          command: "printf background-prefix; sleep 30",
          cwd: process.cwd(),
          timeoutMs: 5_000,
          environmentGrants: [],
        },
        environment,
        "test",
      );
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;
      const taskId = started.task.taskId;
      let task = await registry.dependencies.getTask(taskId);
      for (
        let n = 0;
        n < 100 && !task?.records.some((record) => record.text.includes("background-prefix"));
        n++
      ) {
        await delay(20);
        task = await registry.dependencies.getTask(taskId);
      }
      assert.ok(task?.records.some((record) => record.text.includes("background-prefix")));
      await Promise.all([
        registry.dependencies.stopTask(taskId),
        registry.dependencies.getTask(taskId),
      ]);
      const stopped = await registry.dependencies.getTask(taskId);
      assert.equal(stopped?.state, "stopped");
      assert.equal(stopped?.timedOut, false);
      assert.ok(stopped?.records.some((record) => record.text.includes("background-prefix")));
    } finally {
      await registry.disposeAll();
      await registry.flush();
    }
  });
});
