// These existing adapters use Node filesystem APIs. POSIX path policy is selected
// from the workspace root; Win32 process/FFI modules are not dependencies.
export { createWindowsFileReader as createLinuxFileReader } from "../windows/windows-directory-reader.js";
export { createWindowsFsAdapter as createLinuxFsAdapter } from "../windows/windows-fs-adapter.js";
export { createWindowsMutationAdapter as createLinuxMutationAdapter } from "../windows/windows-mutation-adapter.js";
export { createWindowsWriteAdapter as createLinuxWriteAdapter } from "../windows/windows-write-adapter.js";
