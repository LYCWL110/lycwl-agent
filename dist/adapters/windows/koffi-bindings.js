import koffi, {} from "koffi";
/**
 * Minimal Win32 surface used by the process supervisor.
 *
 * Only the calls below are bound, with explicit signatures. Job Object
 * configuration is applied before any process is assigned, and kill-on-job-close
 * means a Harness crash cannot leave the tree running.
 *
 * `koffi.load` is guarded by the platform, so importing this module on Linux
 * never opens `kernel32.dll`. Every binding is still a value, so call sites and
 * types are unchanged; using one off-win32 fails closed instead of dereferencing
 * a library that was never loaded.
 */
const kernel32 = process.platform === "win32" ? koffi.load("kernel32.dll") : null;
/**
 * Stand-in for a bound entry point when the platform has no `kernel32`.
 *
 * koffi types a binding as a callable carrying `async` and `info` metadata, so
 * the shape is asserted once here rather than reconstructed at every call site.
 */
const unavailable = (() => {
    throw new Error(`Win32 bindings are unavailable on ${process.platform}`);
});
function bind(signature) {
    return kernel32 === null ? unavailable : kernel32.func(signature);
}
export const CREATE_SUSPENDED = 0x0000_0004;
export const CREATE_NO_WINDOW = 0x0800_0000;
export const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400;
export const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000;
export const STARTF_USESTDHANDLES = 0x0000_0100;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
export const WAIT_OBJECT_0 = 0;
export const WAIT_TIMEOUT = 258;
export const INFINITE = 0xffff_ffff;
export const STILL_ACTIVE = 259;
export const CreateJobObjectW = bind("void* __stdcall CreateJobObjectW(void* lpJobAttributes, const char16_t* lpName)");
export const SetInformationJobObject = bind("bool __stdcall SetInformationJobObject(void* hJob, int JobObjectInfoClass, void* lpJobObjectInfo, uint32_t cbJobObjectInfoLength)");
export const AssignProcessToJobObject = bind("bool __stdcall AssignProcessToJobObject(void* hJob, void* hProcess)");
export const TerminateJobObject = bind("bool __stdcall TerminateJobObject(void* hJob, uint32_t uExitCode)");
export const CreateProcessW = bind("bool __stdcall CreateProcessW(const char16_t* lpApplicationName, char16_t* lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, bool bInheritHandles, uint32_t dwCreationFlags, void* lpEnvironment, const char16_t* lpCurrentDirectory, void* lpStartupInfo, void* lpProcessInformation)");
export const ResumeThread = bind("uint32_t __stdcall ResumeThread(void* hThread)");
export const TerminateProcess = bind("bool __stdcall TerminateProcess(void* hProcess, uint32_t exitCode)");
export const WaitForSingleObject = bind("uint32_t __stdcall WaitForSingleObject(void* hHandle, uint32_t dwMilliseconds)");
export const GetExitCodeProcess = bind("bool __stdcall GetExitCodeProcess(void* hProcess, _Out_ uint32_t* lpExitCode)");
export const CloseHandle = bind("bool __stdcall CloseHandle(void* hObject)");
export const CreateFileW = bind("void* __stdcall CreateFileW(const char16_t* lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, void* lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, void* hTemplateFile)");
export const GetLastError = bind("uint32_t __stdcall GetLastError()");
export const CreatePipe = bind("bool __stdcall CreatePipe(void* hReadPipe, void* hWritePipe, void* lpPipeAttributes, uint32_t nSize)");
export const SetHandleInformation = bind("bool __stdcall SetHandleInformation(void* hObject, uint32_t dwMask, uint32_t dwFlags)");
export const PeekNamedPipe = bind("bool __stdcall PeekNamedPipe(void* hNamedPipe, void* lpBuffer, uint32_t nBufferSize, void* lpBytesRead, void* lpTotalBytesAvail, void* lpBytesLeftThisMessage)");
export const ReadFile = bind("bool __stdcall ReadFile(void* hFile, void* lpBuffer, uint32_t nNumberOfBytesToRead, void* lpNumberOfBytesRead, void* lpOverlapped)");
export const InitializeProcThreadAttributeList = bind("bool __stdcall InitializeProcThreadAttributeList(void* lpAttributeList, uint32_t dwAttributeCount, uint32_t dwFlags, void* lpSize)");
export const UpdateProcThreadAttribute = bind("bool __stdcall UpdateProcThreadAttribute(void* lpAttributeList, uint32_t dwFlags, uintptr_t Attribute, void* lpValue, size_t cbSize, void* lpPreviousValue, void* lpReturnSize)");
export const DeleteProcThreadAttributeList = bind("void __stdcall DeleteProcThreadAttributeList(void* lpAttributeList)");
export function writePointer(buffer, offset, value) {
    koffi.encode(buffer, offset, "void*", value);
}
/** Reads a Win32 HANDLE out of a PROCESS_INFORMATION buffer. */
export function readHandle(pi, offset) {
    return pi.readBigUInt64LE(offset);
}
export function readPid(pi) {
    return pi.readUInt32LE(16);
}
/**
 * Build a JOBOBJECT_EXTENDED_LIMIT_INFORMATION buffer with only
 * LimitFlags = KILL_ON_JOB_CLOSE set. The struct is sized for x64; the used
 * field lives at offset 16.
 */
export function buildKillOnCloseLimits() {
    const buffer = Buffer.alloc(144);
    buffer.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    return buffer;
}
/** Build the STARTUPINFO buffer required to start a child with inherited handles. */
export function buildStartupInfo(useStandardHandles) {
    const startupInfo = Buffer.alloc(104);
    startupInfo.writeUInt32LE(104, 0);
    if (useStandardHandles)
        startupInfo.writeUInt32LE(STARTF_USESTDHANDLES, 60);
    return startupInfo;
}
/** UTF-16LE, NUL-terminated command line buffer. */
export function commandLineBuffer(command) {
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
export function buildEnvironmentBlock(environment) {
    // Windows requires case-insensitive alphabetical order by name.
    const names = Object.keys(environment).sort((left, right) => {
        const a = left.toUpperCase();
        const b = right.toUpperCase();
        if (a < b)
            return -1;
        if (a > b)
            return 1;
        return left < right ? -1 : left > right ? 1 : 0;
    });
    let block = "";
    for (const name of names) {
        block += `${name}=${environment[name] ?? ""}\0`;
    }
    // An empty environment still needs the terminating NUL, otherwise
    // CreateProcessW would read past the buffer.
    block += names.length === 0 ? "\0\0" : "\0";
    return Buffer.from(block, "utf16le");
}
