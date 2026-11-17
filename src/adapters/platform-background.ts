// Only the selected platform may evaluate native bindings.
const implementation =
  process.platform === "linux"
    ? await import("./linux/background-registry.ts")
    : process.platform === "win32"
      ? await import("./windows/background-registry.ts")
      : null;

type CreateBackgroundRegistry =
  typeof import("./windows/background-registry.ts").createBackgroundRegistry;

const unsupported: CreateBackgroundRegistry = () => {
  throw new Error(`Unsupported platform: ${process.platform}`);
};

export const createBackgroundRegistry: CreateBackgroundRegistry =
  implementation === null ? unsupported : implementation.createBackgroundRegistry;
