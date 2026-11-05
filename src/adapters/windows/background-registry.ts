import type { BackgroundTask, OutputRecord } from "../../domain/process/background.ts";
import type { ShellRequest } from "../../domain/process/shell.ts";
import type { BackgroundToolDependencies } from "../tools/background-tools.ts";
import { createProcessSupervisor } from "./process-supervisor.ts";

/**
 * Real background task supervision on top of the G02 process supervisor.
 *
 * A background task keeps its Job and process handles until it is stopped or
 * observed to have exited. Output is read from the supervisor's own bounded
 * capture files, so a runaway producer cannot grow unbounded memory here.
 */
export type BackgroundRegistry = Readonly<{
  dependencies: BackgroundToolDependencies;
  /** Task ids still holding a live process and job handle. */
  liveTaskIds: () => readonly string[];
  /** Release every task; used on Session close and in tests. */
  disposeAll: () => void;
}>;

type StreamState = {
  /** Bytes already captured into published records. */
  capturedBytes: number;
  /** Partial multi-byte character held until the next poll completes it. */
  pending: Buffer;
};

type Entry = {
  task: BackgroundTask;
  processId: number;
  executionId: string;
  stdout: StreamState;
  stderr: StreamState;
  /** Wall-clock deadline; the task is terminated once it passes. */
  deadlineMs: number;
  /** Set once the task is deliberately stopped; keeps the state sticky. */
  stopped: boolean;
};

export function createBackgroundRegistry(
  options: Readonly<{
    sessionMode: "read_only" | "workspace_write";
    inheritedEnvironment: Readonly<Record<string, string>>;
    providerCredentialNames?: readonly string[];
  }>,
): BackgroundRegistry {
  const supervisor = createProcessSupervisor();
  const entries = new Map<string, Entry>();
  const timers = new Map<string, NodeJS.Timeout>();
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  function refresh(entry: Entry): BackgroundTask {
    // Enforce the confirmed timeout at the same points the task is observed, so a
    // task cannot run indefinitely just because nobody polls it in between.
    if (Date.now() >= entry.deadlineMs && supervisor.isAlive(entry.processId)) {
      // Capture whatever was produced before terminating: stopping the job
      // removes its handles and the capture would otherwise be lost.
      const { stdout, stderr } = supervisor.readOutput(entry.processId);
      const partial = [
        ...appendStream(entry, "stdout", stdout),
        ...appendStream(entry, "stderr", stderr),
      ];
      entry.task = {
        ...entry.task,
        records: [...entry.task.records, ...partial],
        state: "stopped",
        timedOut: true,
      };
      supervisor.stop(entry.processId);
      return { ...entry.task, exitCode: null, captureComplete: true };
    }

    const alive = supervisor.isAlive(entry.processId);
    const exitCode = supervisor.exitCodeOf(entry.processId);
    const { stdout, stderr } = supervisor.readOutput(entry.processId);

    // Append only bytes that have not been published yet. Record indices and
    // stream byte offsets are stable, so a returned cursor keeps meaning.
    const newRecords = [
      ...appendStream(entry, "stdout", stdout),
      ...appendStream(entry, "stderr", stderr),
    ];

    return {
      ...entry.task,
      state: entry.stopped || entry.task.timedOut ? "stopped" : alive ? "running" : "exited",
      exitCode,
      records: [...entry.task.records, ...newRecords],
      captureComplete: true,
      timedOut: entry.task.timedOut,
    };
  }

  /**
   * Publish the new tail of one stream as an immutable record.
   *
   * The supervisor's capture read returns the whole file each time, so this
   * slices from the already-published byte count. A trailing incomplete UTF-8
   * sequence is held back rather than emitted as a replacement character.
   */
  function appendStream(
    entry: Entry,
    stream: "stdout" | "stderr",
    text: string,
  ): readonly OutputRecord[] {
    const state = stream === "stdout" ? entry.stdout : entry.stderr;
    const full = Buffer.concat([state.pending, Buffer.from(text, "utf8")]);
    const alreadyPublished = state.capturedBytes - state.pending.length;
    if (full.length <= alreadyPublished) return [];

    const fresh = full.subarray(alreadyPublished);
    const usable = trimIncompleteUtf8(fresh);
    if (usable.length === 0) {
      state.pending = fresh;
      state.capturedBytes = alreadyPublished + fresh.length;
      return [];
    }

    state.pending = fresh.subarray(usable.length);
    state.capturedBytes = alreadyPublished + fresh.length;

    return [
      {
        recordIndex: entry.task.records.length,
        stream,
        streamByteStart: alreadyPublished,
        byteLength: usable.length,
        text: usable.toString("utf8"),
      },
    ];
  }

  const dependencies: BackgroundToolDependencies = {
    sessionMode: options.sessionMode,
    inheritedEnvironment: options.inheritedEnvironment,
    ...(options.providerCredentialNames === undefined
      ? {}
      : { providerCredentialNames: options.providerCredentialNames }),

    async startProcess(request: ShellRequest, environment, label) {
      const taskId = nextId("task");
      const executionId = nextId("exec");
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
      entries.set(taskId, {
        task,
        processId: start.handle.processId,
        executionId,
        deadlineMs: Date.now() + request.timeoutMs,
        stopped: false,
        stdout: { capturedBytes: 0, pending: Buffer.alloc(0) },
        stderr: { capturedBytes: 0, pending: Buffer.alloc(0) },
      });

      // Enforce the deadline even when nobody polls: a runaway background task
      // must not outlive its approved timeout.
      const timer = setTimeout(() => {
        const entry = entries.get(taskId);
        if (entry === undefined) return;
        if (!supervisor.isAlive(entry.processId)) return;
        const { stdout, stderr } = supervisor.readOutput(entry.processId);
        const partial = [
          ...appendStream(entry, "stdout", stdout),
          ...appendStream(entry, "stderr", stderr),
        ];
        entry.task = {
          ...entry.task,
          records: [...entry.task.records, ...partial],
          state: "stopped",
          timedOut: true,
        };
        supervisor.stop(entry.processId);
        timers.delete(taskId);
      }, request.timeoutMs);
      timer.unref?.();
      timers.set(taskId, timer);

      return { kind: "started", task };
    },

    async getTask(taskId: string): Promise<BackgroundTask | null> {
      const entry = entries.get(taskId);
      if (entry === undefined) return null;
      const refreshed = refresh(entry);
      entry.task = refreshed;
      return refreshed;
    },

    async stopTask(taskId: string): Promise<void> {
      const entry = entries.get(taskId);
      if (entry === undefined) return;
      clearTimer(taskId);

      // Capture output before stopping: the handles are released on stop.
      const { stdout, stderr } = supervisor.readOutput(entry.processId);
      const partial = [
        ...appendStream(entry, "stdout", stdout),
        ...appendStream(entry, "stderr", stderr),
      ];
      supervisor.stop(entry.processId);
      entry.stopped = true;
      entry.task = {
        ...entry.task,
        records: [...entry.task.records, ...partial],
        state: "stopped",
        exitCode: null,
        timedOut: false,
        captureComplete: true,
      };
    },
  };

  function clearTimer(taskId: string): void {
    const timer = timers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(taskId);
    }
  }

  return {
    dependencies,
    liveTaskIds: () => [...entries.keys()],
    disposeAll: () => {
      for (const taskId of [...timers.keys()]) clearTimer(taskId);
      for (const entry of entries.values()) supervisor.stop(entry.processId);
      entries.clear();
    },
  };
}

/**
 * Number of leading bytes that form complete UTF-8 sequences. A trailing
 * partial sequence is excluded so it can be completed on the next poll instead
 * of being emitted as a replacement character.
 */
function trimIncompleteUtf8(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes;

  // Find the last lead byte and check whether its sequence is complete.
  let index = bytes.length - 1;
  while (index >= 0 && (bytes[index] ?? 0) & 0xc0) {
    if (((bytes[index] ?? 0) & 0xc0) === 0xc0) break;
    index -= 1;
  }
  // `index` now points at a lead byte or a 1-byte ASCII character.
  const lead = bytes[index] ?? 0;
  const needed =
    (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
  const available = bytes.length - index;
  return available < needed ? bytes.subarray(0, index) : bytes;
}
