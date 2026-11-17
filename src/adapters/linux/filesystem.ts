// These existing adapters use Node filesystem APIs. POSIX path policy is selected
// from the workspace root; Win32 process/FFI modules are not dependencies.

export { createWindowsFileReader as createLinuxFileReader } from "../windows/windows-directory-reader.ts";
export { createWindowsFsAdapter as createLinuxFsAdapter } from "../windows/windows-fs-adapter.ts";
export { createWindowsMutationAdapter as createLinuxMutationAdapter } from "../windows/windows-mutation-adapter.ts";
export { createWindowsWriteAdapter as createLinuxWriteAdapter } from "../windows/windows-write-adapter.ts";
