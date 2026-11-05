#!/usr/bin/env node
import { createConfigStore, defaultConfigDirectory } from "../adapters/windows/config-store.ts";
import { createFileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { readProviderConfig } from "../domain/config/provider-config.ts";
import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { describeSelection, selectRuntime } from "./runtime-selection.ts";

/**
 * `lycwl` entry point.
 *
 * The runtime is chosen from configuration, never from a flag, so a configured
 * machine cannot silently fall back to the demo and appear to work. The selection
 * prints its reason before the TUI takes the screen.
 */
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "lycwl - local agent TUI",
      "",
      "Usage:",
      "  lycwl            start the interactive TUI",
      "  lycwl --setup    show configuration status and file locations",
      "  lycwl --help     show this help",
      "  lycwl --version  show the package version",
      "",
      "With no configured Provider the TUI runs a demo runtime that performs no",
      "network, credential, process or write access.",
      "",
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

const dataDirectory = defaultConfigDirectory(process.env["LOCALAPPDATA"]);
const configStore = createConfigStore({ directory: dataDirectory });
const vault = createFileVault({ directory: dataDirectory });

if (args.includes("--setup")) {
  process.stdout.write(`${(await describeConfiguration(await configStore.load())).join("\n")}\n`);
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

const loaded = await configStore.load();
const settings = loaded.ok ? parseSettings(loaded.value.text) : null;
const selection = await selectRuntime({
  workspaceRoot: process.cwd(),
  dataDirectory,
  settings,
  hasSettings: loaded.ok,
});

process.stderr.write(`${describeSelection(selection).join("\n")}\n\n`);

startTui(createTuiController({ coordinator: selection.coordinator }));

async function describeConfiguration(
  state: Awaited<ReturnType<typeof configStore.load>>,
): Promise<readonly string[]> {
  const lines = [`settings:    ${configStore.filePath}`, `credentials: ${vault.filePath}`];
  if (!state.ok) {
    lines.push("", `status: ${state.code}`, "no Provider is configured");
  } else {
    const provider = readProviderConfig(parseSettings(state.value.text));
    lines.push("", `revision: ${state.value.revision}`);
    lines.push(
      provider.ok
        ? `provider: ${provider.value.protocol} ${provider.value.model} -> ${provider.value.baseUrl}`
        : `provider: invalid (${provider.code}${provider.field === undefined ? "" : `: ${provider.field}`})`,
    );
  }
  lines.push("", "credentials are stored unencrypted (ADR-0038)");
  return lines;
}

function parseSettings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : {};
}
