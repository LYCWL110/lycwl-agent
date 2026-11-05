import koffi from "koffi";

/**
 * Minimal Win32 surface used by the process supervisor.
 *
 * Only the calls below are bound, with explicit signatures. Job Object
 * configuration is applied before any process is assigned, and kill-on-job-close
 * means a Harness crash cannot leave the tree running.
 */

const kernel32 = koffi.load("kernel32.dll");

export const CREATE_SUSPENDED = 0x0000_0004;
export const CREATE_NO_WINDOW = 0x0800_0000;
export const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400;
export const STARTF_USESTDHANDLES = 0x0000_0100;

export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;

export const WAIT_OBJECT_0 = 0;
export const WAIT_TIMEOUT = 258;
export const INFINITE = 0xffff_ffff;
export const STILL_ACTIVE = 259;

export const CreateJobObjectW = kernel32.func(
  "void* __stdcall CreateJobObjectW(void* lpJobAttributes, const char16_t* lpName)",
);
export const SetInformationJobObject = kernel32.func(
  "bool __stdcall SetInformationJobObject(void* hJob, int JobObjectInfoClass, void* lpJobObjectInfo, uint32_t cbJobObjectInfoLength)",
);
export const AssignProcessToJobObject = kernel32.func(
  "bool __stdcall AssignProcessToJobObject(void* hJob, void* hProcess)",
);
export const TerminateJobObject = kernel32.func(
  "bool __stdcall TerminateJobObject(void* hJob, uint32_t uExitCode)",
);
export const CreateProcessW = kernel32.func(
  "bool __stdcall CreateProcessW(const char16_t* lpApplicationName, char16_t* lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, bool bInheritHandles, uint32_t dwCreationFlags, void* lpEnvironment, const char16_t* lpCurrentDirectory, void* lpStartupInfo, void* lpProcessInformation)",
);
export const ResumeThread = kernel32.func("uint32_t __stdcall ResumeThread(void* hThread)");
export const WaitForSingleObject = kernel32.func(
  "uint32_t __stdcall WaitForSingleObject(void* hHandle, uint32_t dwMilliseconds)",
);
export const GetExitCodeProcess = kernel32.func(
  "bool __stdcall GetExitCodeProcess(void* hProcess, _Out_ uint32_t* lpExitCode)",
);
export const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void* hObject)");
export const GetLastError = kernel32.func("uint32_t __stdcall GetLastError()");

/** Reads a Win32 HANDLE out of a PROCESS_INFORMATION buffer. */
export function readHandle(pi: Buffer, offset: number): bigint {
  return pi.readBigUInt64LE(offset);
}

export function readPid(pi: Buffer): number {
  return pi.readUInt32LE(16);
}

/**
 * Build a JOBOBJECT_EXTENDED_LIMIT_INFORMATION buffer with only
 * LimitFlags = KILL_ON_JOB_CLOSE set. The struct is sized for x64; the used
 * field lives at offset 16.
 */
export function buildKillOnCloseLimits(): Buffer {
  const buffer = Buffer.alloc(144);
  buffer.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  return buffer;
}

/** Build the STARTUPINFO buffer required to start a child with inherited handles. */
export function buildStartupInfo(useStandardHandles: boolean): Buffer {
  const startupInfo = Buffer.alloc(104);
  startupInfo.writeUInt32LE(104, 0);
  if (useStandardHandles) startupInfo.writeUInt32LE(STARTF_USESTDHANDLES, 60);
  return startupInfo;
}

/** UTF-16LE, NUL-terminated command line buffer. */
export function commandLineBuffer(command: string): Buffer {
  return Buffer.from(`${command}\0`, "utf16le");
}

/**
 * Build a Windows environment block from an explicit name/value map.
 *
 * Format: NUL-terminated UTF-16LE `NAME=VALUE` strings, sorted by name, then one
 * extra NUL to terminate the block.
 *
 * Why this exists: passing `null` as `lpEnvironment` makes the child inherit the
 * entire parent environment, which silently defeated the confirmed C09 filter.
 * The filter result is now the *only* environment the child sees.
 *
 * Known limitation: Node's `process.env` does not expose the hidden per-drive
 * current-directory variables (`=C:=C:\...`). A child launched from an explicit
 * block therefore has no per-drive current directory until it changes one. This
 * affects relative path resolution on drives other than the working directory's;
 * it does not affect the working directory passed to CreateProcessW itself.
 */
export function buildEnvironmentBlock(environment: Readonly<Record<string, string>>): Buffer {
  // Windows requires case-insensitive alphabetical order by name.
  const names = Object.keys(environment).sort((left, right) => {
    const a = left.toUpperCase();
    const b = right.toUpperCase();
    if (a < b) return -1;
    if (a > b) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let block = "";
  for (const name of names) {
    block += `${name}=${environment[name] ?? ""}\0`;
  }
  // An empty environment still needs the terminating NUL, otherwise
  // CreateProcessW would read past the buffer.
  block += "\0";
  return Buffer.from(block, "utf16le");
}
