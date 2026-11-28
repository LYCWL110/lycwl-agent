// Only the selected platform may evaluate native bindings.
const implementation = process.platform === "linux"
    ? await import("./linux/process-supervisor.js")
    : process.platform === "win32"
        ? await import("./windows/process-supervisor.js")
        : null;
export const createProcessSupervisor = implementation === null
    ? () => {
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
    : implementation.createProcessSupervisor;
