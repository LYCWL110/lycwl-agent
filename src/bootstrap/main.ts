#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { createConfigStore, defaultConfigDirectory } from "../adapters/windows/config-store.ts";
import { createFileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { readProviderConfig } from "../domain/config/provider-config.ts";
import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { describeSelection, selectRuntime } from "./runtime-selection.ts";
import { needsSetup, startSetupFlow } from "./setup-flow.ts";

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
      "  lycwl               start the interactive TUI (read-only)",
      "  lycwl --write       allow file mutations, each requiring approval",
      "  lycwl --skills      enable the .agents/skills catalog (default off)",
      "  lycwl --shell       enable shell and background commands (implies --write)",
      "  lycwl --setup       show configuration status and file locations",
      "  lycwl --help        show this help",
      "  lycwl --version     show the package version",
      "",
      "With no configured Provider the TUI runs a demo runtime that performs no",
      "network, credential, process or write access.",
      "",
      "Shell is disabled unless --shell is given. Every command needs its own",
      "approval and runs with your full Windows user permissions: v1 has no sandbox.",
      "",
      "Skills are disabled unless --skills is given; enabling them grants no",
      "read permission beyond ordinary file access.",
      "",
      "Write tools are disabled unless --write is given. Every write still needs",
      "its own approval in the TUI.",
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

// First-time setup: when no Provider is configured there is nothing to run, so the
// setup screen is shown instead of a demo session that would look like a working
// agent. `hasProvider` reads the document rather than guessing from file presence.
const configureFirst = await needsSetup(configStore);

if (configureFirst) {
  process.stderr.write(
    [
      "mode: setup",
      "no Provider is configured yet",
      "enter an endpoint, model and API key, then press enter to save",
      "",
    ].join("\n"),
  );
  const flow = startSetupFlow({
    configStore,
    vault,
    workspaceRoot: process.cwd(),
    dataDirectory,
    onReady: (lines) => {
      process.stderr.write(`${lines.join("\n")}\n\n`);
    },
    onDiscard: () => {
      process.stderr.write("setup discarded; nothing was written\n");
    },
  });
  await flow.done;
  process.exit(0);
}

const loaded = await configStore.load();
const settings = loaded.ok ? parseSettings(loaded.value.text) : null;

// A stable Session per workspace, so launching again in the same project
// continues the same durable log instead of starting from nothing.
const sessionId = workspaceSessionId(process.cwd());
const selection = await selectRuntime({
  workspaceRoot: process.cwd(),
  dataDirectory,
  settings,
  hasSettings: loaded.ok,
  // A read-only Session refuses Shell by design, so --shell implies write mode.
  enableWrites: args.includes("--write") || args.includes("--shell"),
  enableSkills: args.includes("--skills"),
  enableProcesses: args.includes("--shell"),
  sessionId,
});

// Report whether an earlier session exists, so the user knows the history is
// being continued rather than silently reused.
const priorEvents = await readPriorEventCount(sessionId);
if (priorEvents > 0) {
  process.stderr.write(`continuing session ${sessionId} (${priorEvents} recorded event(s))\n`);
}

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

/**
 * Derive a stable Session id from the workspace path.
 *
 * The id must be filesystem-safe and stable across launches, so a hash of the
 * normalised path is used rather than a random id. Case and trailing separators are
 * normalised because Windows paths are case-insensitive.
 */
function workspaceSessionId(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return `ws-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

/** Count events already recorded for a Session, so a resumed launch can say so. */
async function readPriorEventCount(sessionId: string): Promise<number> {
  const { JsonlEventLog } = await import("../adapters/persistence/jsonl-event-log.ts");
  const digests = {
    async sha256Canonical(value: unknown): Promise<string> {
      return createHash("sha256").update(JSON.stringify(value)).digest("hex");
    },
  };
  const ids = { create: () => crypto.randomUUID() };
  const log = new JsonlEventLog(path.join(dataDirectory, "sessions"), ids, digests);
  try {
    const result = await log.readWithRecovery(sessionId);
    return result.ok ? result.events.length : 0;
  } catch {
    return 0;
  }
}
