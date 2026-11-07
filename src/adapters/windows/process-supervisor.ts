import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  AssignProcessToJobObject,
  buildEnvironmentBlock,
  buildKillOnCloseLimits,
  buildStartupInfo,
  CloseHandle,
  CREATE_NO_WINDOW,
  CREATE_SUSPENDED,
  CREATE_UNICODE_ENVIRONMENT,
  CreateJobObjectW,
  CreateProcessW,
  commandLineBuffer,
  GetExitCodeProcess,
  GetLastError,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
  ResumeThread,
  readHandle,
  readPid,
  SetInformationJobObject,
  STILL_ACTIVE,
  TerminateJobObject,
  TerminateProcess,
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
  WaitForSingleObject,
} from "./koffi-bindings.ts";
import {
  createPowerShellCapturePaths,
  type PowerShellCapturePaths,
  powershellCommand,
  powershellExecutable,
} from "./powershell-command.ts";

/**
 * Windows process supervisor (G02).
 *
 * Lifecycle: create the Job object with kill-on-close, create the process
 * suspended, assign it to the Job, then resume. If assignment fails the suspended
 * process is terminated and closed without ever running.
 *
 * Output is captured through temporary files rather than pipes: this keeps the
 * implementation free of inherited-handle bookkeeping. Polling observes the
 * combined byte limit and terminates excess producers; retained reads share one
 * cap. Disk writes can overshoot between observations.
 *
 * Supervision failure is fatal for the affected operation: the caller disables
 * the tool rather than downgrading to an unsupervised spawn.
 */

export type SupervisorFailure =
  | "job_create_failed"
  | "job_configure_failed"
  | "process_create_failed"
  | "job_assign_failed"
  | "resume_failed"
  | "process_cancelled"
  | "wait_failed";

export type SpawnRequest = Readonly<{
  command: string;
  cwd: string;
  timeoutMs: number;
  /**
   * The already-filtered environment. This becomes the child's entire
   * environment, so a filtered credential cannot be inherited back in from the
   * parent. Required: there is no inherit-everything default.
   */
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  capturePaths?: PowerShellCapturePaths;
}>;

export type SpawnOutcome =
  | Readonly<{
      kind: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      cancelled: boolean;
      processId: number;
      rawBytes: number;
      captureComplete: boolean;
      outputLimitExceeded: boolean;
    }>
  | Readonly<{ kind: "failed"; code: SupervisorFailure }>;

export type RunningTask = Readonly<{
  taskId: string;
  processId: number;
  command: string;
  cwd: string;
  startedAtMs: number;
}>;

export type RunningHandle = Readonly<{
  processId: number;
  stdoutPath: string;
  stderrPath: string;
}>;

export type StartHandle =
  | Readonly<{ ok: true; handle: RunningHandle }>
  | Readonly<{ ok: false; code: SupervisorFailure }>;

export type SupervisedProcess = Readonly<{
  processId: number;
  stdoutPath: string;
  stderrPath: string;
}>;

export function createProcessSupervisor() {
  const running = new Map<
    number,
    { job: unknown; process: unknown; stdoutPath: string; stderrPath: string }
  >();

  /**
   * Create the job, start the process suspended, assign it, resume it, and hand
   * back the live handles without waiting. The caller polls `isAlive`, reads the
   * capture files and eventually calls `stop`.
   */
  function start(
    request: Readonly<{
      command: string;
      cwd: string;
      executionId: string;
      environment: Readonly<Record<string, string>>;
      capturePaths?: PowerShellCapturePaths;
    }>,
  ): StartHandle {
    const job = CreateJobObjectW(null, null);
    if (job === null) return { ok: false, code: "job_create_failed" };

    const limits = buildKillOnCloseLimits();
    if (
      !SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)
    ) {
      CloseHandle(job);
      return { ok: false, code: "job_configure_failed" };
    }

    const { stdoutPath, stderrPath } = request.capturePaths ?? createPowerShellCapturePaths();
    const fullCommand = powershellCommand(request.command, stdoutPath, stderrPath);

    const startupInfo = buildStartupInfo(false);
    const processInfo = Buffer.alloc(24);
    const commandLine = commandLineBuffer(fullCommand);
    const environmentBlock = buildEnvironmentBlock(request.environment);

    const created = CreateProcessW(
      powershellExecutable(),
      commandLine,
      null,
      null,
      false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      environmentBlock,
      request.cwd,
      startupInfo,
      processInfo,
    );
    if (!created) {
      CloseHandle(job);
      return { ok: false, code: "process_create_failed" };
    }

    const hProcess = readHandle(processInfo, 0);
    const hThread = readHandle(processInfo, 8);
    const processId = readPid(processInfo);

    if (!AssignProcessToJobObject(job, hProcess)) {
      TerminateProcess(hProcess, 1);
      CloseHandle(hThread);
      CloseHandle(hProcess);
      CloseHandle(job);
      return { ok: false, code: "job_assign_failed" };
    }
    if (ResumeThread(hThread) === 0xffff_ffff) {
      TerminateJobObject(job, 1);
      CloseHandle(hThread);
      CloseHandle(hProcess);
      CloseHandle(job);
      return { ok: false, code: "resume_failed" };
    }
    CloseHandle(hThread);

    running.set(processId, { job, process: hProcess, stdoutPath, stderrPath });
    return { ok: true, handle: { processId, stdoutPath, stderrPath } };
  }

  /** True while the supervised process has not exited. */
  function isAlive(processId: number): boolean {
    const entry = running.get(processId);
    if (entry === undefined) return false;
    return WaitForSingleObject(entry.process, 0) === WAIT_TIMEOUT;
  }

  /** Exit code once the process has exited, or null while it still runs. */
  function exitCodeOf(processId: number): number | null {
    const entry = running.get(processId);
    if (entry === undefined) return null;
    if (WaitForSingleObject(entry.process, 0) === WAIT_TIMEOUT) return null;
    const code = [0];
    return GetExitCodeProcess(entry.process, code) ? (code[0] ?? null) : null;
  }

  /**
   * Terminate the whole job tree and release handles. Applied twice it is a
   * no-op, so a completion notification and a user stop cannot conflict.
   */
  function stop(processId: number): CaptureOutput {
    const entry = running.get(processId);
    if (entry === undefined) return emptyOutput();
    TerminateJobObject(entry.job, 1);
    CloseHandle(entry.job);
    const stopped = WaitForSingleObject(entry.process, 5000) === WAIT_OBJECT_0;
    CloseHandle(entry.process);
    running.delete(processId);
    if (!stopped) throw new Error("process_termination_unconfirmed");
    const output = readCaptureOutput(entry.stdoutPath, entry.stderrPath);
    removeCapture(entry.stdoutPath);
    removeCapture(entry.stderrPath);
    return output;
  }

  /** Read the current capture files without removing them. */
  function readOutput(processId: number): CaptureOutput {
    const entry = running.get(processId);
    if (entry === undefined) return emptyOutput();
    return readCaptureOutput(entry.stdoutPath, entry.stderrPath);
  }
  return { runToCompletion, start, isAlive, exitCodeOf, stop, readOutput };
  /**
   * Run a command to completion under a Job object, terminating the whole tree on
   * timeout. Capture files are removed afterwards.
   */
  async function runToCompletion(request: SpawnRequest): Promise<SpawnOutcome> {
    if (request.signal?.aborted) return { kind: "failed", code: "process_cancelled" };
    const job = CreateJobObjectW(null, null);
    if (job === null) return { kind: "failed", code: "job_create_failed" };

    const limits = buildKillOnCloseLimits();
    if (
      !SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)
    ) {
      CloseHandle(job);
      return { kind: "failed", code: "job_configure_failed" };
    }

    const { stdoutPath, stderrPath } = request.capturePaths ?? createPowerShellCapturePaths();

    // Redirect the complete script block so each PowerShell pipeline is captured.
    const fullCommand = powershellCommand(request.command, stdoutPath, stderrPath);
    const startupInfo = buildStartupInfo(false);
    const processInfo = Buffer.alloc(24);
    const commandLine = commandLineBuffer(fullCommand);
    const environmentBlock = buildEnvironmentBlock(request.environment);

    const created = CreateProcessW(
      powershellExecutable(),
      commandLine,
      null,
      null,
      false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      environmentBlock,
      request.cwd,
      startupInfo,
      processInfo,
    );
    if (!created) {
      CloseHandle(job);
      return { kind: "failed", code: "process_create_failed" };
    }

    const hProcess = readHandle(processInfo, 0);
    const hThread = readHandle(processInfo, 8);
    const processId = readPid(processInfo);

    if (!AssignProcessToJobObject(job, hProcess)) {
      // The process is still suspended, so terminating it runs nothing.
      TerminateProcess(hProcess, 1);
      CloseHandle(hThread);
      CloseHandle(hProcess);
      CloseHandle(job);
      return { kind: "failed", code: "job_assign_failed" };
    }

    if (ResumeThread(hThread) === 0xffff_ffff) {
      TerminateJobObject(job, 1);
      CloseHandle(hThread);
      CloseHandle(hProcess);
      CloseHandle(job);
      return { kind: "failed", code: "resume_failed" };
    }
    CloseHandle(hThread);

    const deadline = Date.now() + request.timeoutMs;
    let wait = WaitForSingleObject(hProcess, 0);
    let outputLimitExceeded = captureSize(stdoutPath, stderrPath) > MAX_CAPTURE_BYTES;
    while (
      wait === WAIT_TIMEOUT &&
      Date.now() < deadline &&
      !request.signal?.aborted &&
      !outputLimitExceeded
    ) {
      await delay(25);
      wait = WaitForSingleObject(hProcess, 0);
      outputLimitExceeded = captureSize(stdoutPath, stderrPath) > MAX_CAPTURE_BYTES;
    }
    let timedOut = false;
    const cancelled = request.signal?.aborted === true;
    let terminationConfirmed = true;
    if (wait === WAIT_TIMEOUT) {
      timedOut = !cancelled && !outputLimitExceeded;
      TerminateJobObject(job, 1);
      terminationConfirmed = WaitForSingleObject(hProcess, 5000) === WAIT_OBJECT_0;
    } else if (wait !== WAIT_OBJECT_0) {
      TerminateJobObject(job, 1);
      CloseHandle(hProcess);
      CloseHandle(job);
      return { kind: "failed", code: "wait_failed" };
    }

    const exitCodeBuffer = [0];
    const gotExit = GetExitCodeProcess(hProcess, exitCodeBuffer);
    const exitCode = gotExit ? (exitCodeBuffer[0] ?? STILL_ACTIVE) : STILL_ACTIVE;

    CloseHandle(hProcess);
    CloseHandle(job);

    const output = readCaptureOutput(stdoutPath, stderrPath);
    await unlink(stdoutPath).catch(() => undefined);
    await unlink(stderrPath).catch(() => undefined);
    if (!terminationConfirmed || exitCode === STILL_ACTIVE)
      return { kind: "failed", code: "wait_failed" };

    return {
      kind: "completed",
      exitCode: timedOut ? 1 : exitCode,
      ...output,
      outputLimitExceeded: outputLimitExceeded || output.outputLimitExceeded,
      captureComplete: !outputLimitExceeded && output.captureComplete,
      timedOut,
      cancelled,
      processId,
    };
  }
}

export type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;

/** Read a capture file with a hard bound so a huge producer cannot exhaust memory. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export type CaptureOutput = Readonly<{
  stdout: string;
  stderr: string;
  rawBytes: number;
  captureComplete: boolean;
  outputLimitExceeded: boolean;
}>;

function emptyOutput(): CaptureOutput {
  return { stdout: "", stderr: "", rawBytes: 0, captureComplete: true, outputLimitExceeded: false };
}

function removeCapture(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function captureSize(stdoutPath: string, stderrPath: string): number {
  try {
    return (
      (existsSync(stdoutPath) ? statSync(stdoutPath).size : 0) +
      (existsSync(stderrPath) ? statSync(stderrPath).size : 0)
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Disk may overshoot between polls; retained data always shares one byte cap. */
function readCaptureOutput(stdoutPath: string, stderrPath: string): CaptureOutput {
  try {
    const stdout = readCaptureFile(stdoutPath, MAX_CAPTURE_BYTES);
    const stderr = readCaptureFile(stderrPath, MAX_CAPTURE_BYTES - stdout.bytes.length);
    const rawBytes = stdout.size + stderr.size;
    return {
      stdout: decodeCapture(stdout.bytes),
      stderr: decodeCapture(stderr.bytes),
      rawBytes,
      captureComplete: rawBytes === stdout.bytes.length + stderr.bytes.length,
      outputLimitExceeded: rawBytes > MAX_CAPTURE_BYTES,
    };
  } catch {
    return { ...emptyOutput(), captureComplete: false };
  }
}

function decodeCapture(bytes: Buffer): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const decoder = new TextDecoder(utf16 ? "utf-16le" : "utf-8", { fatal: true });
  return decoder.decode(utf16 ? bytes.subarray(2) : bytes, { stream: true });
}

function readCaptureFile(filePath: string, budget: number): { bytes: Buffer; size: number } {
  if (!existsSync(filePath)) return { bytes: Buffer.alloc(0), size: 0 };
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, budget));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return { bytes: buffer.subarray(0, read), size };
  } finally {
    closeSync(fd);
  }
}

export { GetLastError };
