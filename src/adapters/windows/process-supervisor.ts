import { setTimeout as delay } from "node:timers/promises";
import type { OwnedKeyRegistry } from "../../domain/security/owned-key-guard.ts";
import {
  type CaptureOutput,
  createBoundedProcessOutput,
  type ProcessStream,
} from "./bounded-process-output.ts";
import {
  AssignProcessToJobObject,
  buildEnvironmentBlock,
  buildKillOnCloseLimits,
  CloseHandle,
  CREATE_NO_WINDOW,
  CREATE_SUSPENDED,
  CREATE_UNICODE_ENVIRONMENT,
  CreateJobObjectW,
  CreateProcessW,
  commandLineBuffer,
  EXTENDED_STARTUPINFO_PRESENT,
  GetExitCodeProcess,
  GetLastError,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
  ResumeThread,
  readHandle,
  readPid,
  SetInformationJobObject,
  TerminateJobObject,
  TerminateProcess,
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
  WaitForSingleObject,
} from "./koffi-bindings.ts";
import { powershellCommand, powershellExecutable } from "./powershell-command.ts";
import { createProcessPipes, readAvailablePipe } from "./process-pipes.ts";

export { type CaptureOutput, MAX_CAPTURE_BYTES } from "./bounded-process-output.ts";

export type SupervisorFailure =
  | "job_create_failed"
  | "job_configure_failed"
  | "pipe_setup_failed"
  | "process_create_failed"
  | "job_assign_failed"
  | "resume_failed"
  | "process_cancelled"
  | "wait_failed";

type ProcessRequest = Readonly<{
  command: string;
  cwd: string;
  /** The complete, already-filtered environment; never implicitly inherited. */
  environment: Readonly<Record<string, string>>;
}>;
export type SpawnRequest = ProcessRequest & Readonly<{ timeoutMs: number; signal?: AbortSignal }>;
export type SpawnOutcome =
  | (CaptureOutput &
      Readonly<{
        kind: "completed";
        exitCode: number;
        timedOut: boolean;
        cancelled: boolean;
        processId: number;
      }>)
  | Readonly<{ kind: "failed"; code: SupervisorFailure }>;
export type RunningHandle = Readonly<{ processId: number }>;
export type StartHandle =
  | Readonly<{ ok: true; handle: RunningHandle }>
  | Readonly<{ ok: false; code: SupervisorFailure }>;

type Entry = {
  job: unknown;
  process: bigint;
  pipes: ReturnType<typeof createProcessPipes>;
  output: ReturnType<typeof createBoundedProcessOutput>;
  eof: Record<ProcessStream, boolean>;
};

/**
 * Suspended creation -> Job assignment -> resume. Anonymous pipes provide
 * backpressure, an explicit handle whitelist, and zero raw capture-file writes.
 * Peek/read work per observation is bounded so a producer cannot monopolize TUI.
 */
export function createProcessSupervisor(options: Readonly<{ ownedKeys?: OwnedKeyRegistry }> = {}) {
  const running = new Map<number, Entry>();
  const buffer = Buffer.alloc(64 * 1024);

  function start(request: ProcessRequest & Readonly<{ executionId: string }>): StartHandle {
    const output = createBoundedProcessOutput(options.ownedKeys);
    if (output.snapshot().deliveryBlocked !== null) return { ok: false, code: "pipe_setup_failed" };
    const job = CreateJobObjectW(null, null);
    if (job === null) return { ok: false, code: "job_create_failed" };
    let pipes: ReturnType<typeof createProcessPipes> | undefined;
    let processHandle: bigint | undefined;
    let thread: bigint | undefined;
    let retained = false;
    let stage: SupervisorFailure = "job_configure_failed";
    try {
      const limits = buildKillOnCloseLimits();
      if (
        !SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)
      )
        return { ok: false, code: stage };
      stage = "pipe_setup_failed";
      pipes = createProcessPipes();
      stage = "process_create_failed";
      const processInfo = Buffer.alloc(24);
      if (
        !CreateProcessW(
          powershellExecutable(),
          commandLineBuffer(powershellCommand(request.command)),
          null,
          null,
          true,
          CREATE_SUSPENDED |
            CREATE_NO_WINDOW |
            CREATE_UNICODE_ENVIRONMENT |
            EXTENDED_STARTUPINFO_PRESENT,
          buildEnvironmentBlock(request.environment),
          request.cwd,
          pipes.startupInfo,
          processInfo,
        )
      )
        return { ok: false, code: stage };
      processHandle = readHandle(processInfo, 0);
      thread = readHandle(processInfo, 8);
      pipes.created();
      stage = "job_assign_failed";
      if (!AssignProcessToJobObject(job, processHandle)) return { ok: false, code: stage };
      stage = "resume_failed";
      if (ResumeThread(thread) === 0xffff_ffff) return { ok: false, code: stage };
      const processId = readPid(processInfo);
      running.set(processId, {
        job,
        process: processHandle,
        pipes,
        output,
        eof: { stdout: false, stderr: false },
      });
      retained = true;
      return { ok: true, handle: { processId } };
    } catch {
      return { ok: false, code: stage };
    } finally {
      if (thread !== undefined) CloseHandle(thread);
      if (!retained) {
        if (processHandle !== undefined) {
          TerminateProcess(processHandle, 1);
          WaitForSingleObject(processHandle, 5000);
          CloseHandle(processHandle);
        }
        CloseHandle(job);
        pipes?.dispose();
      }
    }
  }

  function drain(entry: Entry, final: boolean): void {
    // One extra byte detects excess without retaining/writing past the cap.
    const readsPerStream = final ? 130 : 8;
    for (const stream of ["stdout", "stderr"] as const) {
      for (let i = 0; i < readsPerStream && !entry.eof[stream]; i++) {
        if (entry.output.stopped()) return;
        const read = readAvailablePipe(entry.pipes[stream], buffer, entry.output.remaining() + 1);
        if (read.kind === "idle") break;
        if (read.kind === "failed") {
          entry.output.fail();
          return;
        }
        if (read.kind === "eof") {
          entry.eof[stream] = true;
          break;
        }
        if (read.kind === "data") entry.output.push(stream, read.bytes);
      }
    }
  }

  function isAlive(processId: number): boolean {
    const entry = running.get(processId);
    return entry !== undefined && WaitForSingleObject(entry.process, 0) === WAIT_TIMEOUT;
  }
  function exitCodeOf(processId: number): number | null {
    const entry = running.get(processId);
    if (entry === undefined || WaitForSingleObject(entry.process, 0) !== WAIT_OBJECT_0) return null;
    const code = [0];
    return GetExitCodeProcess(entry.process, code) ? (code[0] ?? null) : null;
  }
  function readOutput(processId: number): CaptureOutput {
    const entry = running.get(processId);
    if (entry === undefined) return emptyOutput();
    drain(entry, false);
    const output = entry.output.snapshot();
    if (entry.output.stopped()) TerminateJobObject(entry.job, 1);
    return output;
  }
  function stop(processId: number): CaptureOutput {
    const entry = running.get(processId);
    if (entry === undefined) return emptyOutput();
    try {
      TerminateJobObject(entry.job, 1);
      CloseHandle(entry.job);
      entry.job = null;
      if (WaitForSingleObject(entry.process, 5000) !== WAIT_OBJECT_0)
        throw new Error("process_termination_unconfirmed");
      drain(entry, true);
      entry.output.finish(entry.eof.stdout && entry.eof.stderr);
      return entry.output.snapshot();
    } finally {
      if (entry.job !== null) CloseHandle(entry.job);
      CloseHandle(entry.process);
      entry.pipes.dispose();
      running.delete(processId);
    }
  }
  async function runToCompletion(request: SpawnRequest): Promise<SpawnOutcome> {
    if (request.signal?.aborted) return { kind: "failed", code: "process_cancelled" };
    const started = start({ ...request, executionId: "foreground" });
    if (!started.ok) return { kind: "failed", code: started.code };
    const processId = started.handle.processId;
    const deadline = Date.now() + request.timeoutMs;
    let released = false;
    try {
      let output = readOutput(processId);
      while (
        isAlive(processId) &&
        Date.now() < deadline &&
        !request.signal?.aborted &&
        output.captureComplete
      ) {
        await delay(25);
        output = readOutput(processId);
      }
      const cancelled = request.signal?.aborted === true;
      const timedOut = isAlive(processId) && !cancelled && output.captureComplete;
      const exitCode = exitCodeOf(processId);
      const final = stop(processId);
      released = true;
      // Termination due to cancellation/limits is an execution fact, not rollback.
      if (exitCode === null && !timedOut && !cancelled && final.captureComplete)
        return { kind: "failed", code: "wait_failed" };
      return {
        kind: "completed",
        ...final,
        exitCode: exitCode ?? 1,
        timedOut,
        cancelled,
        processId,
      };
    } catch {
      return { kind: "failed", code: "wait_failed" };
    } finally {
      if (!released) stop(processId);
    }
  }
  return { runToCompletion, start, isAlive, exitCodeOf, stop, readOutput };
}

export type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;

function emptyOutput(): CaptureOutput {
  return {
    stdout: "",
    stderr: "",
    rawBytes: 0,
    captureComplete: true,
    outputLimitExceeded: false,
    deliveryBlocked: null,
  };
}

export { GetLastError };
