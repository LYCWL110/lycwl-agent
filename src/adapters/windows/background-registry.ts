import {
  BACKGROUND_LIMITS,
  type BackgroundTask,
  type OutputRecord,
} from "../../domain/process/background.ts";
import {
  checkProtectedExit,
  type OwnedKeyRegistry,
} from "../../domain/security/owned-key-guard.ts";
import type { BackgroundToolDependencies } from "../tools/background-tools.ts";
import {
  type CaptureOutput,
  createProcessSupervisor,
  MAX_CAPTURE_BYTES,
} from "./process-supervisor.ts";

export type BackgroundRegistry = Readonly<{
  dependencies: BackgroundToolDependencies;
  liveTaskIds: () => readonly string[];
  disposeAll: () => void;
}>;

type Entry = {
  task: BackgroundTask;
  processId: number;
  deadlineMs: number;
  released: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  retainedBytes: number;
};

export function createBackgroundRegistry(
  options: Readonly<{
    sessionMode: "read_only" | "workspace_write";
    inheritedEnvironment: Readonly<Record<string, string>>;
    providerCredentialNames?: readonly string[];
    ownedKeys?: OwnedKeyRegistry;
    refreshOwnedKeys?: () => Promise<void>;
  }>,
): BackgroundRegistry {
  const supervisor = createProcessSupervisor(
    options.ownedKeys === undefined ? {} : { ownedKeys: options.ownedKeys },
  );
  const entries = new Map<string, Entry>();
  const timers = new Map<string, NodeJS.Timeout>();
  let counter = 0;
  let cancellationVersion = 0;

  function clearTimer(taskId: string): void {
    const timer = timers.get(taskId);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(taskId);
  }

  function publish(entry: Entry, output: CaptureOutput): void {
    if (output.deliveryBlocked !== null) {
      entry.task = {
        ...entry.task,
        records: [],
        captureComplete: false,
        deliveryBlocked: output.deliveryBlocked,
      };
      return;
    }
    const records: OutputRecord[] = [...entry.task.records];
    let complete = entry.task.captureComplete && output.captureComplete;
    for (const stream of ["stdout", "stderr"] as const) {
      const bytes = Buffer.from(output[stream], "utf8");
      const key = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      let offset = entry[key];
      if (bytes.length < offset) {
        complete = false;
        continue;
      }
      while (offset < bytes.length) {
        let end = Math.min(
          bytes.length,
          offset + BACKGROUND_LIMITS.maxRecordBytes,
          offset + MAX_CAPTURE_BYTES - entry.retainedBytes,
        );
        while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
        if (end === offset) {
          complete = false;
          break;
        }
        const length = end - offset;
        records.push({
          recordIndex: records.length,
          stream,
          streamByteStart: offset,
          byteLength: length,
          text: bytes.subarray(offset, end).toString("utf8"),
        });
        entry.retainedBytes += length;
        offset = end;
      }
      entry[key] = offset;
    }
    entry.task = { ...entry.task, records, captureComplete: complete };
  }

  function release(entry: Entry): CaptureOutput {
    try {
      const output = supervisor.stop(entry.processId);
      entry.released = true;
      clearTimer(entry.task.taskId);
      return output;
    } catch (error) {
      entry.task = { ...entry.task, state: "unknown", captureComplete: false };
      clearTimer(entry.task.taskId);
      throw error;
    }
  }

  function refresh(entry: Entry, stopRequested = false): BackgroundTask {
    if (entry.released) return entry.task;
    const alive = supervisor.isAlive(entry.processId);
    const exitCode = supervisor.exitCodeOf(entry.processId);
    const output = supervisor.readOutput(entry.processId);
    const timedOut = alive && Date.now() >= entry.deadlineMs;
    const limited = output.outputLimitExceeded || !output.captureComplete;
    if (!alive || timedOut || limited || stopRequested) {
      // Drain the remaining bounded pipe bytes after termination.
      const final = release(entry);
      publish(entry, final);
      entry.task = {
        ...entry.task,
        state: alive ? "stopped" : "exited",
        exitCode: alive ? null : exitCode,
        timedOut,
        captureComplete: entry.task.captureComplete && !limited && !final.outputLimitExceeded,
      };
    } else {
      publish(entry, output);
    }
    return entry.task;
  }

  const dependencies: BackgroundToolDependencies = {
    sessionMode: options.sessionMode,
    inheritedEnvironment: options.inheritedEnvironment,
    ...(options.providerCredentialNames === undefined
      ? {}
      : { providerCredentialNames: options.providerCredentialNames }),
    async startProcess(request, environment, label, _toolCallId, signal) {
      const startVersion = cancellationVersion;
      await options.refreshOwnedKeys?.();
      if (signal?.aborted || startVersion !== cancellationVersion)
        return { kind: "unknown", safeCode: "background_start_cancelled" };
      const taskId = `task-${++counter}`;
      const executionId = `exec-${++counter}`;
      const start = supervisor.start({
        command: request.command,
        cwd: request.cwd,
        executionId,
        environment,
      });
      if (!start.ok) return { kind: "unknown", safeCode: start.code };
      const task: BackgroundTask = {
        taskId,
        processExecutionId: executionId,
        label: label.length === 0 ? taskId : label,
        state: "running",
        exitCode: null,
        records: [],
        captureComplete: true,
        timedOut: false,
      };
      const entry: Entry = {
        task,
        processId: start.handle.processId,
        deadlineMs: Date.now() + request.timeoutMs,
        released: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        retainedBytes: 0,
      };
      entries.set(taskId, entry);
      // Observe exit and output growth even if the model never polls the task.
      const timer = setInterval(() => {
        try {
          refresh(entry);
        } catch {
          entry.task = { ...entry.task, state: "unknown", captureComplete: false };
          clearTimer(taskId);
        }
      }, 50);
      timer.unref();
      timers.set(taskId, timer);
      return { kind: "started", task };
    },
    async getTask(taskId) {
      await options.refreshOwnedKeys?.();
      const entry = entries.get(taskId);
      if (entry === undefined) return null;
      refresh(entry);
      // Retained records must also honour rotations after the process has ended.
      if (options.ownedKeys !== undefined && entry.task.deliveryBlocked === undefined) {
        for (const stream of ["stdout", "stderr"] as const) {
          const text = entry.task.records
            .filter((record) => record.stream === stream)
            .map((record) => record.text)
            .join("");
          const decision = checkProtectedExit(options.ownedKeys, text);
          if (!decision.allowed) {
            entry.task = {
              ...entry.task,
              records: [],
              captureComplete: false,
              deliveryBlocked: decision.reason,
            };
            break;
          }
        }
      }
      return entry.task;
    },
    async stopTask(taskId) {
      const entry = entries.get(taskId);
      if (entry !== undefined) refresh(entry, true);
    },
  };

  return {
    dependencies,
    liveTaskIds: () => [...entries].filter(([, entry]) => !entry.released).map(([id]) => id),
    disposeAll: () => {
      cancellationVersion++;
      let failed = false;
      for (const entry of entries.values()) {
        try {
          refresh(entry, true);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("background_cleanup_unconfirmed");
      for (const taskId of timers.keys()) clearTimer(taskId);
      entries.clear();
    },
  };
}
