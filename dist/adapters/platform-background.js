// Only the selected platform may evaluate native bindings.
const implementation = process.platform === "linux"
    ? await import("./linux/background-registry.js")
    : process.platform === "win32"
        ? await import("./windows/background-registry.js")
        : null;
const unsupported = () => {
    throw new Error(`Unsupported platform: ${process.platform}`);
};
export const createBackgroundRegistry = implementation === null ? unsupported : implementation.createBackgroundRegistry;
