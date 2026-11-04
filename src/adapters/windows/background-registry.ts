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

type Entry = {
  task: BackgroundTask;
  processId: number;
  executionId: string;
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
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  function refresh(entry: Entry): BackgroundTask {
    const alive = supervisor.isAlive(entry.processId);
    const exitCode = supervisor.exitCodeOf(entry.processId);
    const { stdout, stderr } = supervisor.readOutput(entry.processId);
    return {
      ...entry.task,
      state: alive ? "running" : "exited",
      exitCode,
      records: toRecords(stdout, stderr),
      captureComplete: true,
      timedOut: false,
    };
  }

  const dependencies: BackgroundToolDependencies = {
    sessionMode: options.sessionMode,
    inheritedEnvironment: options.inheritedEnvironment,
    ...(options.providerCredentialNames === undefined
      ? {}
      : { providerCredentialNames: options.providerCredentialNames }),

    async startProcess(request: ShellRequest, _environment, label) {
      const taskId = nextId("task");
      const executionId = nextId("exec");
      const start = supervisor.start({
        command: request.command,
        cwd: request.cwd,
        executionId,
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
      entries.set(taskId, { task, processId: start.handle.processId, executionId });
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
      supervisor.stop(entry.processId);
      entry.task = { ...refresh(entry), state: "stopped", exitCode: null };
    },
  };

  return {
    dependencies,
    liveTaskIds: () => [...entries.keys()],
    disposeAll: () => {
      for (const entry of entries.values()) supervisor.stop(entry.processId);
      entries.clear();
    },
  };
}

/**
 * Convert raw capture text into the per-stream records the paging layer expects.
 * Source provenance is preserved: stdout and stderr never merge into one chunk.
 */
function toRecords(stdout: string, stderr: string): readonly OutputRecord[] {
  const records: OutputRecord[] = [];
  let index = 0;
  if (stdout.length > 0) {
    records.push({
      recordIndex: index,
      stream: "stdout",
      streamByteStart: 0,
      byteLength: Buffer.byteLength(stdout, "utf8"),
      text: stdout,
    });
    index += 1;
  }
  if (stderr.length > 0) {
    records.push({
      recordIndex: index,
      stream: "stderr",
      streamByteStart: 0,
      byteLength: Buffer.byteLength(stderr, "utf8"),
      text: stderr,
    });
  }
  return records;
}
