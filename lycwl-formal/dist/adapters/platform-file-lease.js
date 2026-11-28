// Only the selected platform may evaluate native bindings.
const implementation = process.platform === "linux"
    ? await import("./linux/exclusive-file-lease.js")
    : process.platform === "win32"
        ? await import("./windows/exclusive-file-lease.js")
        : null;
const unsupported = () => {
    throw new Error(`Unsupported platform: ${process.platform}`);
};
export const acquireExclusiveFileLease = implementation === null ? unsupported : implementation.acquireExclusiveFileLease;
