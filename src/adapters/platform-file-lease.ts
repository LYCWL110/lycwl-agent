// Only the selected platform may evaluate native bindings.
const implementation =
  process.platform === "linux"
    ? await import("./linux/exclusive-file-lease.ts")
    : process.platform === "win32"
      ? await import("./windows/exclusive-file-lease.ts")
      : null;

type AcquireExclusiveFileLease =
  typeof import("./windows/exclusive-file-lease.ts").acquireExclusiveFileLease;

const unsupported: AcquireExclusiveFileLease = () => {
  throw new Error(`Unsupported platform: ${process.platform}`);
};

export const acquireExclusiveFileLease: AcquireExclusiveFileLease =
  implementation === null ? unsupported : implementation.acquireExclusiveFileLease;
export type { ExclusiveFileLease } from "./windows/exclusive-file-lease.ts";
