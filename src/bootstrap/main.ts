import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { createDemoRuntime } from "./demo-runtime.ts";

/**
 * Demo entry point: `node src/bootstrap/main.ts`.
 *
 * Runs the real Runtime and TUI against a scripted Provider and fake tools. It
 * touches no file, process, network or credential; it exists so the interface
 * can be inspected and exercised.
 */
const runtime = createDemoRuntime();
const controller = createTuiController({ coordinator: runtime.coordinator });

startTui(controller);
