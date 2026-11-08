#!/usr/bin/env node
import { fetchModelDetails, fetchModelList } from "../adapters/providers/model-list.ts";
import { createConfigStore, defaultConfigDirectory } from "../adapters/windows/config-store.ts";
import { createFileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import type { CatalogModel } from "../domain/config/model-catalog.ts";
import { readProviderConfig } from "../domain/config/provider-config.ts";
import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { hasProvider, startConfigFlow } from "./config-flow.ts";
import { describeSelection, selectRuntime } from "./runtime-selection.ts";
import { canResumeSession, selectSessionLaunch } from "./session-launch.ts";

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
      "  lycwl --resume ID   explicitly continue a recorded conversation",
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

const launch = selectSessionLaunch(args);
if (!launch.ok) {
  process.stderr.write(`${launch.message}\n`);
  process.exit(1);
}
let sessionId = launch.sessionId;

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
const configureFirst = !(await hasProvider(configStore));

if (configureFirst) {
  process.stderr.write(
    [
      "mode: setup",
      "no Provider is configured yet",
      "enter an endpoint, model and API key, then press enter to save",
      "",
    ].join("\n"),
  );
  const flow = startConfigFlow({
    fetchModels: fetchModelsForBrowser,
    fetchModel: fetchModelDetails,
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
  if ((await flow.done) === "discarded") process.exit(0);
}

process.stderr.write(`${launch.mode === "new" ? "new" : "resuming"} session ${sessionId}\n`);

// Reopen configuration from inside the Session. The browser replaces the app,
// so the app is unmounted first and the flow rebuilds this same Session afterwards.
function openConfig(initialPage: "setup" | "model" = "setup"): void {
  const flow = startConfigFlow({
    initialPage,
    fetchModels: fetchModelsForBrowser,
    fetchModel: fetchModelDetails,
    configStore,
    vault,
    workspaceRoot: process.cwd(),
    dataDirectory,
    onReady: (lines) => {
      process.stderr.write(`${lines.join("\n")}\n\n`);
      startSession();
    },
    onDiscard: () => {
      process.stderr.write("configuration unchanged\n");
      startSession();
    },
  });
  void flow.done;
}

/**
 * Fetch the provider's model list for the configuration browser.
 *
 * This is the one place a configuration-time network request happens. A failure
 * returns a typed failure so the browser can distinguish it from an empty list.
 */
async function fetchModelsForBrowser(input: {
  protocol: string;
  baseUrl: string;
  apiKey: string;
}): Promise<readonly (string | CatalogModel)[] | Readonly<{ ok: false; code: string }>> {
  const result = await fetchModelList({
    protocol: input.protocol as never,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  return result.ok ? (result.catalog ?? result.models) : result;
}

async function startSession(): Promise<void> {
  const loadedNow = await configStore.load();
  const current = loadedNow.ok ? parseSettings(loadedNow.value.text) : null;
  const chosen = await selectRuntime({
    workspaceRoot: process.cwd(),
    dataDirectory,
    settings: current,
    hasSettings: loadedNow.ok,
    enableWrites: args.includes("--write") || args.includes("--shell"),
    enableSkills: args.includes("--skills"),
    enableProcesses: args.includes("--shell"),
    sessionId,
  });
  process.stderr.write(`${describeSelection(chosen).join("\n")}\n\n`);
  startTui(
    createTuiController({
      coordinator: chosen.coordinator,
      ...(chosen.kind === "real" ? { initialEvents: chosen.historyEvents } : {}),
      canResumeSession: (id) => canResumeSession(dataDirectory, id),
      ...(chosen.kind !== "real"
        ? {}
        : {
            correctCredential: async (secret: string) => {
              if (chosen.coordinator.configurationWaitView() === null) return false;
              const written = await vault.write({
                reference: chosen.config.credentialRef,
                purpose: "provider_api_key",
                secret,
              });
              return written.ok;
            },
          }),
    }),
    {
      ...(chosen.kind === "real" ? { modelLabel: chosen.config.model } : {}),
      modeLabel: args.includes("--shell")
        ? "shell"
        : args.includes("--write")
          ? "workspace-write"
          : "read-only",
      onConfigRequest: openConfig,
      sessionId,
      onSessionRequest: (requestedId) => {
        sessionId = requestedId ?? crypto.randomUUID();
        process.stderr.write(`${requestedId === null ? "new" : "resuming"} session ${sessionId}\n`);
        void startSession();
      },
    },
  );
}

void startSession();

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
