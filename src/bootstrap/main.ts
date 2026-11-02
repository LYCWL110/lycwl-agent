#!/usr/bin/env node
import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { createDemoRuntime } from "./demo-runtime.ts";

/**
 * `lycwl` entry point.
 *
 * Runs the real Runtime and TUI against a scripted Provider and fake tools. It
 * touches no file, process, network or credential; it exists so the interface
 * can be inspected and exercised.
 */
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "lycwl - local agent TUI (demo runtime)",
      "",
      "Usage:",
      "  lycwl            start the interactive TUI",
      "  lycwl --help     show this help",
      "  lycwl --version  show the package version",
      "",
      "The demo runtime uses a scripted provider and fake tools.",
      "It performs no file, process, network or credential access.",
      "An interactive terminal is required.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("lycwl-agent 0.1.0\n");
  process.exit(0);
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    [
      "lycwl requires an interactive terminal.",
      "Ink cannot enable raw mode on a piped or background stdin.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const runtime = createDemoRuntime();
const controller = createTuiController({ coordinator: runtime.coordinator });

startTui(controller);
