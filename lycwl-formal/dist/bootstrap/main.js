#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createSnapshotStore } from "../adapters/persistence/snapshot-store.js";
import { fetchModelDetails, fetchModelList } from "../adapters/providers/model-list.js";
import { createConfigStore } from "../adapters/windows/config-store.js";
import { createFileVault } from "../adapters/windows/file-credential-vault.js";
import { createSessionCatalog } from "../adapters/windows/session-catalog.js";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.js";
import { readMcpServerEntries } from "../domain/config/mcp-edit.js";
import { readProviderConfig } from "../domain/config/provider-config.js";
import { filterChildEnvironment } from "../domain/process/shell.js";
import { sessionLabel } from "../domain/session/session-catalog.js";
import { createTuiController } from "../tui/controller.js";
import { startTui } from "../tui/main.js";
import { hasProvider, startConfigFlow } from "./config-flow.js";
import { saveMcpChange } from "./mcp-save.js";
import { permissionModeFromArgs } from "./permission-mode.js";
import { createClipboardReader, hostPlatform, platformDirectories } from "./platform.js";
import { describeSelection, selectRuntime } from "./runtime-selection.js";
import { SEARCH_CREDENTIAL_REFERENCE, storeSearchKey } from "./search-key.js";
import { canResumeSession, selectSessionLaunch } from "./session-launch.js";
import { createTerminalApproval } from "./terminal-approval.js";
import { undoSessionChanges } from "./undo.js";
import { launchWeb } from "./web-launch.js";
/**
 * `lycwl` entry point.
 *
 * Web is the default presentation. Pass `--cli` when an interactive terminal is
 * preferred; `--web` remains accepted as an explicit alias for compatibility.
 */
const args = process.argv.slice(2);
const permissionMode = permissionModeFromArgs(args);
if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write([
        "lycwl - local coding agent",
        "",
        "Usage:",
        "  lycwl               start the browser UI on 127.0.0.1",
        "  lycwl --cli         start the interactive terminal UI",
        "  lycwl --web         explicit browser UI alias",
        "  lycwl --web --web-port 8787  pin the browser UI port",
        "  lycwl --read-only   disable writes, shell, web and MCP; read and local search only",
        "  lycwl --skills      enable the .agents/skills catalog (default off)",
        "  lycwl --resume ID   explicitly continue a recorded conversation",
        "  lycwl --search-key  store or replace the Tavily key (input hidden)",
        "  lycwl --setup       show configuration status and file locations",
        "  lycwl --help        show this help",
        "  lycwl --version     show the package version",
        "",
        "A Provider configuration is required before starting a session.",
        "",
        "Writes, shell and web are enabled by default. Every write, command and",
        "web_fetch still needs its own approval. Provider-native search runs inside",
        "the model request without a separate query approval. An approved command",
        `runs with your full ${hostPlatform === "linux" ? "Linux" : "Windows"} user permissions: v1 has no sandbox.`,
        "Web search uses the provider's built-in tool for Anthropic Messages and",
        "OpenAI Responses. Chat Completions uses Tavily; store its key with --search-key.",
        "",
        "Skills are disabled unless --skills is given; enabling them grants no",
        "read permission beyond ordinary file access.",
        "",
        "--write and --shell are accepted for compatibility but ignored. Use",
        "--read-only to opt out of writes, process execution, web and MCP access.",
        "",
        "The browser UI binds 127.0.0.1 only and grants the browser the same",
        "authority as this terminal. Use --cli for an interactive terminal.",
        "",
    ].join("\n"));
    process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("lycwl-agent 0.1.0\n");
    process.exit(0);
}
const directories = platformDirectories();
const dataDirectory = directories.state;
const configStore = createConfigStore({ directory: directories.config });
const vault = createFileVault({ directory: directories.config });
if (args.includes("--search-key")) {
    const stored = await storeSearchKey({ vault });
    process.exit(stored.ok ? 0 : 1);
}
/**
 * Clipboard reader for Ctrl+V.
 *
 * Created once because it only holds configuration; each read spawns its own
 * short-lived child process. The environment goes through the shared filter like
 * every other child.
 */
const clipboardReader = createClipboardReader({
    environment: (() => {
        const inherited = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined)
                inherited[name] = value;
        }
        return filterChildEnvironment(inherited, {}, { platform: hostPlatform }).environment;
    })(),
});
if (args.includes("--setup")) {
    process.stdout.write(`${(await describeConfiguration(await configStore.load())).join("\n")}\n`);
    process.exit(0);
}
if (permissionMode === "full" && (args.includes("--write") || args.includes("--shell"))) {
    process.stderr.write("note: --write and --shell are ignored; writes and shell are enabled by default. Use --read-only to opt out.\n");
}
const launch = selectSessionLaunch(args);
if (!launch.ok) {
    process.stderr.write(`${launch.message}\n`);
    process.exit(1);
}
let sessionId = launch.sessionId;
const webMode = !args.includes("--cli");
const webPort = parseWebPort(args);
if (webPort === undefined) {
    process.stderr.write("--web-port needs a valid port between 0 and 65535\n");
    process.exit(1);
}
if (!webMode && !process.stdin.isTTY) {
    process.stderr.write([
        "lycwl requires an interactive terminal.",
        "Ink cannot enable raw mode on a piped or background stdin.",
        "Use --web to serve the same Session to a browser instead.",
        "",
    ].join("\n"));
    process.exit(1);
}
// First-time setup: when no Provider is configured there is nothing to run, so the
// setup is shown instead of starting without a configured Provider.
const configureFirst = !(await hasProvider(configStore));
if (configureFirst) {
    if (webMode) {
        // The setup flow is an Ink form and needs a terminal.
        process.stderr.write([
            "no Provider is configured yet",
            "run `lycwl --cli --setup` in a terminal, then start `lycwl` again",
            "",
        ].join("\n"));
        process.exit(1);
    }
    else {
        process.stderr.write([
            "mode: setup",
            "no Provider is configured yet",
            "enter an endpoint, model and API key, then press enter to save",
            "",
        ].join("\n"));
        const flow = startConfigFlow({
            discoverContextOnSelection: true,
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
        if ((await flow.done) === "discarded")
            process.exit(0);
    }
}
process.stderr.write(`${launch.mode === "new" ? "new" : "resuming"} session ${sessionId}\n`);
// Reopen configuration from inside the Session. The browser replaces the app,
// so the app is unmounted first and the flow rebuilds this same Session afterwards.
function openConfig(initialPage = "setup") {
    const flow = startConfigFlow({
        discoverContextOnSelection: true,
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
async function fetchModelsForBrowser(input) {
    const result = await fetchModelList({
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
    });
    return result.ok ? (result.catalog ?? result.models) : result;
}
async function startSession() {
    const loadedNow = await configStore.load();
    const current = loadedNow.ok ? parseSettings(loadedNow.value.text) : null;
    const chosen = await selectRuntime({
        workspaceRoot: process.cwd(),
        dataDirectory: directories.config,
        stateDirectory: dataDirectory,
        settings: current,
        hasSettings: loadedNow.ok,
        enableWrites: permissionMode === "full",
        enableSkills: args.includes("--skills"),
        enableProcesses: permissionMode === "full",
        enableWeb: permissionMode === "full",
        readOnly: permissionMode === "read-only",
        sessionId,
        // A declared MCP server must be approved before its process is spawned, which
        // is before the TUI exists. This gate is denial-by-default and is not remembered
        // across launches.
        ...(current === null
            ? {}
            : {
                mcpApprovals: createTerminalApproval({
                    write: (text) => process.stderr.write(`${text}\n`),
                }),
            }),
    });
    if (chosen.kind !== "real") {
        process.stderr.write("Provider configuration is required. Run `lycwl --cli --setup`, then start `lycwl` again.\n");
        process.exit(1);
    }
    process.stderr.write(`${describeSelection(chosen).join("\n")}\n\n`);
    startTui(createTuiController({
        ...(chosen.kind === "real" ? { memory: chosen.memory } : {}),
        workspaceRoot: process.cwd(),
        ...(args.includes("--skills")
            ? {
                skillCatalog: async () => {
                    const { createSkillDiscovery } = await import("../adapters/windows/skill-discovery.js");
                    const discovery = createSkillDiscovery({ workspaceRoot: process.cwd() });
                    const result = await discovery.discover({ enabled: true });
                    if (!result.ok)
                        return { ok: false, code: result.code };
                    return {
                        ok: true,
                        skills: result.catalog.skills.map((skill) => ({
                            skillId: skill.skillId,
                            description: skill.description,
                            bytes: skill.bytes,
                        })),
                    };
                },
            }
            : {}),
        coordinator: chosen.coordinator,
        sessionId,
        ...(chosen.kind === "real" && chosen.config.contextWindow !== null
            ? { contextWindow: chosen.config.contextWindow }
            : {}),
        ...(chosen.kind === "real" ? { initialEvents: chosen.historyEvents } : {}),
        canResumeSession: (id) => canResumeSession(dataDirectory, id),
        ...(chosen.kind !== "real"
            ? {}
            : {
                correctCredential: async (secret) => {
                    if (chosen.coordinator.configurationWaitView() === null)
                        return false;
                    const written = await vault.write({
                        reference: chosen.config.credentialRef,
                        purpose: "provider_api_key",
                        secret,
                    });
                    return written.ok;
                },
            }),
        undoChanges: async () => {
            const snapshots = createSnapshotStore({
                sessionDirectory: path.join(dataDirectory, "sessions", "sessions", sessionId),
                workspaceRoot: process.cwd(),
            });
            // Runs that changed files, newest first: undo walks back from the most
            // recent so a revert restores the state before this Session began.
            const runIds = [
                ...new Set((chosen.kind === "real" ? chosen.historyEvents : [])
                    .filter((event) => event.payload.kind === "run_started")
                    .map((event) => event.runId)),
            ].reverse();
            if (runIds.length === 0)
                return { ok: false, code: "no_snapshots" };
            const undone = await undoSessionChanges({
                store: snapshots,
                workspaceRoot: process.cwd(),
                runIds,
            });
            return undone.ok
                ? { ok: true, files: undone.files }
                : { ok: false, code: undone.code };
        },
        initDraft: async () => {
            const { createProjectInit } = await import("../adapters/windows/project-init.js");
            const scanned = await createProjectInit({ workspaceRoot: process.cwd() }).scan();
            if (!scanned.ok)
                return { ok: false, code: scanned.code };
            if (scanned.alreadyExists)
                return { ok: true, alreadyExists: true };
            return {
                ok: true,
                alreadyExists: false,
                preview: {
                    path: path.join(process.cwd(), "AGENTS.md"),
                    bytes: Buffer.byteLength(scanned.draft, "utf8"),
                    detected: scanned.facts.languages,
                    head: scanned.draft.split("\n").slice(0, 12).join("\n"),
                },
            };
        },
        initWrite: async () => {
            const { createProjectInit } = await import("../adapters/windows/project-init.js");
            const scanned = await createProjectInit({ workspaceRoot: process.cwd() }).scan();
            if (!scanned.ok)
                return { ok: false, code: scanned.code };
            if (scanned.alreadyExists)
                return { ok: false, code: "already_exists" };
            try {
                // `wx` fails when the file appeared between the scan and the write, which is
                // a conflict rather than a write error.
                await writeFile(path.join(process.cwd(), "AGENTS.md"), scanned.draft, {
                    encoding: "utf8",
                    flag: "wx",
                });
                return { ok: true };
            }
            catch (error) {
                const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
                return {
                    ok: false,
                    code: code === "EEXIST" ? "already_exists" : "write_failed",
                };
            }
        },
        sessionCatalog: {
            list: async () => {
                const listed = await createSessionCatalog({ dataDirectory }).list();
                if (!listed.ok)
                    return listed;
                return {
                    ok: true,
                    sessions: listed.sessions.map((entry) => ({
                        sessionId: entry.sessionId,
                        // The label is derived here, once, so the panel never reimplements the
                        // precedence rule and a rename cannot disagree with it.
                        label: sessionLabel(entry),
                        title: entry.title,
                        modifiedAtUtc: entry.modifiedAtUtc,
                        bytes: entry.bytes,
                    })),
                };
            },
            rename: (sessionId, title) => createSessionCatalog({ dataDirectory }).rename(sessionId, title),
            remove: (sessionId) => createSessionCatalog({ dataDirectory }).remove(sessionId),
        },
        mcpServers: async () => {
            const loaded = await configStore.load();
            if (!loaded.ok)
                return { ok: false, code: loaded.code };
            const parsed = parseJsonc(loaded.value.text);
            if (!parsed.ok)
                return { ok: false, code: "config_invalid" };
            return {
                ok: true,
                servers: readMcpServerEntries(loaded.value.text).map((entry) => ({
                    serverId: entry.serverId,
                    command: entry.command,
                    args: entry.args,
                })),
            };
        },
        mcpChange: async (change) => {
            const saved = await saveMcpChange({
                store: configStore,
                ...(change.add === undefined ? {} : { add: { ...change.add, environment: {} } }),
                ...(change.remove === undefined ? {} : { remove: change.remove }),
            });
            if (!saved.ok)
                return { ok: false, code: saved.code };
            return {
                ok: true,
                servers: saved.entries.map((entry) => ({
                    serverId: entry.serverId,
                    command: entry.command,
                    args: entry.args,
                })),
            };
        },
    }), {
        ...(chosen.kind === "real" ? { modelLabel: chosen.config.model } : {}),
        readClipboardImage: () => clipboardReader.readImage(),
        modeLabel: permissionMode,
        onConfigRequest: openConfig,
        sessionId,
        onSessionRequest: (requestedId) => {
            sessionId = requestedId ?? crypto.randomUUID();
            process.stderr.write(`${requestedId === null ? "new" : "resuming"} session ${sessionId}\n`);
            void startSession();
        },
    });
}
if (webMode) {
    await startWebSession();
}
else {
    void startSession();
}
/**
 * Serve the browser front end instead of mounting Ink.
 *
 * The server keeps the process alive while it runs; Ctrl+C closes it cleanly so
 * no SSE stream is left thinking the agent is still there.
 */
async function startWebSession() {
    const launched = await launchWeb({
        workspaceRoot: process.cwd(),
        configDirectory: directories.config,
        dataDirectory,
        permissionMode,
        enableSkills: args.includes("--skills"),
        sessionId,
        port: webPort ?? null,
        write: (text) => process.stderr.write(`${text}\n`),
        onQuit: () => process.exit(0),
    });
    process.stderr.write(`web: ${launched.url}\n`);
    let closing = false;
    const shutdown = () => {
        if (closing)
            return;
        closing = true;
        void launched.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
/**
 * `null` when --web-port is absent, `undefined` when its value is not a port.
 */
function parseWebPort(values) {
    const index = values.indexOf("--web-port");
    if (index === -1)
        return null;
    const raw = values[index + 1];
    if (raw === undefined || !/^\d{1,5}$/.test(raw))
        return undefined;
    const port = Number(raw);
    return port <= 65_535 ? port : undefined;
}
async function describeConfiguration(state) {
    const lines = [`settings:    ${configStore.filePath}`, `credentials: ${vault.filePath}`];
    if (!state.ok) {
        lines.push("", `status: ${state.code}`, "no Provider is configured");
    }
    else {
        const provider = readProviderConfig(parseSettings(state.value.text));
        lines.push("", `revision: ${state.value.revision}`);
        lines.push(provider.ok
            ? `provider: ${provider.value.protocol} ${provider.value.model} -> ${provider.value.baseUrl}`
            : `provider: invalid (${provider.code}${provider.field === undefined ? "" : `: ${provider.field}`})`);
    }
    const search = await vault.readCurrent(SEARCH_CREDENTIAL_REFERENCE, "search_api_key");
    lines.push(search.ok
        ? `search:     configured (${SEARCH_CREDENTIAL_REFERENCE})`
        : search.code === "not_found"
            ? "search:     not configured (run lycwl --search-key)"
            : `search:     unavailable (${search.code})`);
    lines.push("", "credentials are stored unencrypted (ADR-0038)");
    return lines;
}
function parseSettings(text) {
    const parsed = parseJsonc(text);
    return parsed.ok ? toPlainValue(parsed.value) : {};
}
