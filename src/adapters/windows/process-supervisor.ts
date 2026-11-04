import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssignProcessToJobObject,
  buildKillOnCloseLimits,
  buildStartupInfo,
  CloseHandle,
  CREATE_NO_WINDOW,
  CREATE_SUSPENDED,
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
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
  WaitForSingleObject,
} from "./koffi-bindings.ts";

/**
 * Windows process supervisor (G02).
 *
 * Lifecycle: create the Job object with kill-on-close, create the process
 * suspended, assign it to the Job, then resume. If assignment fails the suspended
 * process is terminated and closed without ever running.
 *
 * Output is captured through temporary files rather than pipes: this keeps the
 * implementation free of inherited-handle bookkeeping while still bounding what
 * reaches the model, and the caller applies its own byte and text caps.
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
  | "wait_failed";

export type SpawnRequest = Readonly<{
  command: string;
  cwd: string;
  timeoutMs: number;
}>;

export type SpawnOutcome =
  | Readonly<{
      kind: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      processId: number;
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
    request: Readonly<{ command: string; cwd: string; executionId: string }>,
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

    const token = randomBytes(6).toString("hex");
    const stdoutPath = path.join(tmpdir(), `lycwl-bg-out-${token}.log`);
    const stderrPath = path.join(tmpdir(), `lycwl-bg-err-${token}.log`);
    const fullCommand = `cmd.exe /d /s /c "( ${request.command} ) > "${stdoutPath}" 2> "${stderrPath}""`;

    const startupInfo = buildStartupInfo(false);
    const processInfo = Buffer.alloc(24);
    const commandLine = commandLineBuffer(fullCommand);

    const created = CreateProcessW(
      null,
      commandLine,
      null,
      null,
      false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW,
      null,
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
      TerminateJobObject(job, 1);
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
  function stop(processId: number): void {
    const entry = running.get(processId);
    if (entry === undefined) return;
    TerminateJobObject(entry.job, 1);
    WaitForSingleObject(entry.process, 5000);
    CloseHandle(entry.process);
    CloseHandle(entry.job);
    running.delete(processId);
  }

  /** Read the current capture files without removing them. */
  function readOutput(processId: number): Readonly<{ stdout: string; stderr: string }> {
    const entry = running.get(processId);
    if (entry === undefined) return { stdout: "", stderr: "" };
    return {
      stdout: readCaptureFile(entry.stdoutPath),
      stderr: readCaptureFile(entry.stderrPath),
    };
  }
  return { runToCompletion, start, isAlive, exitCodeOf, stop, readOutput };
  /**
   * Run a command to completion under a Job object, terminating the whole tree on
   * timeout. Capture files are removed afterwards.
   */
  async function runToCompletion(request: SpawnRequest): Promise<SpawnOutcome> {
    const job = CreateJobObjectW(null, null);
    if (job === null) return { kind: "failed", code: "job_create_failed" };

    const limits = buildKillOnCloseLimits();
    if (
      !SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)
    ) {
      CloseHandle(job);
      return { kind: "failed", code: "job_configure_failed" };
    }

    const token = randomBytes(6).toString("hex");
    const stdoutPath = path.join(tmpdir(), `lycwl-out-${token}.log`);
    const stderrPath = path.join(tmpdir(), `lycwl-err-${token}.log`);

    // Parentheses are required: `cmd /c a & b > file` redirects only `b`, which
    // would silently drop earlier output and leak it to the Harness console.
    const fullCommand = `cmd.exe /d /s /c "( ${request.command} ) > "${stdoutPath}" 2> "${stderrPath}""`;
    const startupInfo = buildStartupInfo(false);
    const processInfo = Buffer.alloc(24);
    const commandLine = commandLineBuffer(fullCommand);

    const created = CreateProcessW(
      null,
      commandLine,
      null,
      null,
      false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW,
      null,
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
      TerminateJobObject(job, 1);
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

    const wait = WaitForSingleObject(hProcess, request.timeoutMs);
    let timedOut = false;
    if (wait === WAIT_TIMEOUT) {
      timedOut = true;
      TerminateJobObject(job, 1);
      WaitForSingleObject(hProcess, 5000);
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

    const stdout = readCaptureFile(stdoutPath);
    const stderr = readCaptureFile(stderrPath);
    await unlink(stdoutPath).catch(() => undefined);
    await unlink(stderrPath).catch(() => undefined);

    return {
      kind: "completed",
      exitCode: timedOut ? 1 : exitCode,
      stdout,
      stderr,
      timedOut,
      processId,
    };
  }
}

export type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;

/** Read a capture file with a hard bound so a huge producer cannot exhaust memory. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function readCaptureFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_CAPTURE_BYTES);
    const read = readSync(fd, buffer, 0, MAX_CAPTURE_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export { GetLastError };
