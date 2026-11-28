import path from "node:path";
import { createSnapshotStore } from "../adapters/persistence/snapshot-store.ts";
import { createConfigStore } from "../adapters/windows/config-store.ts";
import { createFileVault } from "../adapters/windows/file-credential-vault.ts";
import { createSessionCatalog } from "../adapters/windows/session-catalog.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { validateProviderConfig } from "../domain/config/provider-config.ts";
import { sessionLabel } from "../domain/session/session-catalog.ts";
import { createTuiController } from "../tui/controller.ts";
import { bundledAssetSource } from "../web/assets.ts";
import type { WebConfigRequest, WebSessionCatalog, WebSessionRuntime } from "../web/protocol.ts";
import { startWebServer } from "../web/server.ts";
import { createWebSessionHost } from "../web/session-host.ts";
import type { PermissionMode } from "./permission-mode.ts";
import { describeSelection, selectRuntime } from "./runtime-selection.ts";
import { canResumeSession } from "./session-launch.ts";
import { undoSessionChanges } from "./undo.ts";

/**
 * Browser presentation entry point for `lycwl web`.
 *
 * The web server is a second front end over the same Runtime: each Session is
 * assembled exactly like the TUI's Session (configuration, credentials, Provider,
 * Coordinator), then wrapped in a `TuiController` the server can drive. Bootstrap
 * keeps this composition because only it knows the process-wide directories.
 */
export type WebLaunchOptions = Readonly<{
  workspaceRoot: string;
  configDirectory: string;
  dataDirectory: string;
  permissionMode: PermissionMode;
  enableSkills: boolean;
  /** Initial Session; the browser can open others through the sidebar. */
  sessionId: string;
  /** Port to bind on loopback, or null for an ephemeral port. */
  port: number | null;
  /** Diagnostics go to stderr in the same shape as the TUI launch. */
  write: (text: string) => void;
  /** Called when the browser asks the server to shut down. */
  onQuit?: () => void;
}>;

export type WebLaunch = Readonly<{
  url: string;
  port: number;
  close: () => Promise<void>;
}>;

export async function launchWeb(options: WebLaunchOptions): Promise<WebLaunch> {
  const configStore = createConfigStore({ directory: options.configDirectory });
  const vault = createFileVault({ directory: options.configDirectory });
  const sessionCatalog = createWebSessionCatalog(options.dataDirectory);

  const assembleSession = async (sessionId: string): Promise<WebSessionRuntime> => {
    const loaded = await configStore.load();
    const current = loaded.ok ? parseSettings(loaded.value.text) : null;
    const chosen = await selectRuntime({
      workspaceRoot: options.workspaceRoot,
      dataDirectory: options.configDirectory,
      stateDirectory: options.dataDirectory,
      settings: current,
      hasSettings: loaded.ok,
      enableWrites: options.permissionMode === "full",
      enableSkills: options.enableSkills,
      enableProcesses: options.permissionMode === "full",
      enableWeb: options.permissionMode === "full",
      readOnly: options.permissionMode === "read-only",
      sessionId,
    });
    const lines = describeSelection(chosen);
    if (lines.length > 0) options.write(lines.join("\n"));

    const controller = createTuiController({
      ...(chosen.kind === "real" ? { memory: chosen.memory } : {}),
      workspaceRoot: options.workspaceRoot,
      ...(options.enableSkills
        ? {
            skillCatalog: async () => {
              const { createSkillDiscovery } = await import(
                "../adapters/windows/skill-discovery.ts"
              );
              const discovery = createSkillDiscovery({ workspaceRoot: options.workspaceRoot });
              const result = await discovery.discover({ enabled: true });
              if (!result.ok) return { ok: false as const, code: result.code };
              return {
                ok: true as const,
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
      canResumeSession: (id) => canResumeSession(options.dataDirectory, id),
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
      undoChanges: async () => {
        const snapshots = createSnapshotStore({
          sessionDirectory: path.join(options.dataDirectory, "sessions", "sessions", sessionId),
          workspaceRoot: options.workspaceRoot,
        });
        const runIds = [
          ...new Set(
            (chosen.kind === "real" ? chosen.historyEvents : [])
              .filter((event) => event.payload.kind === "run_started")
              .map((event) => event.runId),
          ),
        ].reverse();
        if (runIds.length === 0) return { ok: false as const, code: "no_snapshots" };
        const undone = await undoSessionChanges({
          store: snapshots,
          workspaceRoot: options.workspaceRoot,
          runIds,
        });
        return undone.ok
          ? { ok: true as const, files: undone.files }
          : { ok: false as const, code: undone.code };
      },
      initDraft: async () => {
        const { createProjectInit } = await import("../adapters/windows/project-init.ts");
        const scanned = await createProjectInit({ workspaceRoot: options.workspaceRoot }).scan();
        if (!scanned.ok) return { ok: false as const, code: scanned.code };
        if (scanned.alreadyExists) return { ok: true as const, alreadyExists: true as const };
        return {
          ok: true as const,
          alreadyExists: false as const,
          preview: {
            path: path.join(options.workspaceRoot, "AGENTS.md"),
            bytes: Buffer.byteLength(scanned.draft, "utf8"),
            detected: scanned.facts.languages,
            head: scanned.draft.split("\n").slice(0, 12).join("\n"),
          },
        };
      },
      initWrite: async () => {
        const { createProjectInit } = await import("../adapters/windows/project-init.ts");
        const scanned = await createProjectInit({ workspaceRoot: options.workspaceRoot }).scan();
        if (!scanned.ok) return { ok: false as const, code: scanned.code };
        if (scanned.alreadyExists) return { ok: false as const, code: "already_exists" };
        const { writeFile } = await import("node:fs/promises");
        try {
          await writeFile(path.join(options.workspaceRoot, "AGENTS.md"), scanned.draft, {
            encoding: "utf8",
            flag: "wx",
          });
          return { ok: true as const };
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : null;
          return {
            ok: false as const,
            code: code === "EEXIST" ? "already_exists" : "write_failed",
          };
        }
      },
      sessionCatalog,
    });

    return {
      sessionId,
      controller,
      modelLabel: chosen.kind === "real" ? chosen.config.model : null,
      modeLabel: options.permissionMode,
      contextWindow: chosen.kind === "real" ? chosen.config.contextWindow : null,
      demo: chosen.kind !== "real",
      warnings:
        chosen.kind === "real"
          ? chosen.warnings
          : ["尚未配置 Provider，请在设置中填写接口地址、模型和 API Key。"],
    };
  };

  const openSession = async (requestedId: string | null): Promise<WebSessionRuntime> => {
    // `null` means a new Session; a recorded id that does not resolve is a client
    // mistake, not a new Session, so it fails instead of silently forking history.
    const sessionId = requestedId ?? crypto.randomUUID();
    if (requestedId !== null && !(await canResumeSession(options.dataDirectory, requestedId))) {
      throw Object.assign(new Error(`unknown session ${requestedId}`), {
        code: "not_found" as const,
      });
    }
    return assembleSession(sessionId);
  };

  const initial = await assembleSession(options.sessionId);
  const host = createWebSessionHost({ initial, openSession, catalog: sessionCatalog });
  const server = await startWebServer({
    host,
    assets: bundledAssetSource(),
    listen: { hostname: "127.0.0.1", port: options.port ?? 0 },
    ...(options.onQuit === undefined ? {} : { onQuit: options.onQuit }),
    configure: async (request: WebConfigRequest) => {
      const credentialRef = "provider-main";
      const validated = validateProviderConfig({
        protocol: request.protocol,
        baseUrl: request.baseUrl,
        model: request.model,
        credentialRef,
        maxOutputTokens: 4096,
        contextWindow: null,
      });
      if (!validated.ok) throw new Error(`invalid configuration: ${validated.code}`);
      const loaded = await configStore.load();
      const baseRevision = loaded.ok ? loaded.value.revision : 0;
      const baseDocumentHash = loaded.ok ? loaded.value.documentHash : "";
      const draft = JSON.stringify(
        {
          schemaVersion: 1,
          revision: baseRevision,
          provider: { ...validated.value },
        },
        null,
        2,
      );
      const saved = await configStore.save({ baseRevision, baseDocumentHash, draft });
      if (!saved.ok) throw new Error(`configuration save failed: ${saved.code}`);
      const credential = await vault.write({
        reference: credentialRef,
        purpose: "provider_api_key",
        secret: request.apiKey,
      });
      if (!credential.ok) throw new Error(`credential save failed: ${credential.code}`);
    },
  });

  return {
    url: server.url,
    port: server.port,
    close: async () => {
      // Stop accepting requests and end streams before closing the controller, so
      // an in-flight snapshot cannot see a half-closed Session.
      await server.close();
      await host.close();
    },
  };
}

/**
 * Session records for the sidebar, resolved with the same label precedence the
 * TUI panel uses.
 */
function createWebSessionCatalog(dataDirectory: string): WebSessionCatalog {
  const catalog = () => createSessionCatalog({ dataDirectory });
  return {
    list: async () => {
      const listed = await catalog().list();
      if (!listed.ok) return listed;
      return {
        ok: true as const,
        sessions: listed.sessions
          // A launch-only session has no user input and its derived label is the
          // raw UUID. It is an implementation detail, not a conversation row.
          .filter((entry) => entry.title !== null || sessionLabel(entry) !== entry.sessionId)
          .map((entry) => ({
            sessionId: entry.sessionId,
            label: sessionLabel(entry),
            title: entry.title,
            modifiedAtUtc: entry.modifiedAtUtc,
            bytes: entry.bytes,
          })),
      };
    },
    rename: (sessionId, title) => catalog().rename(sessionId, title),
    remove: (sessionId) => catalog().remove(sessionId),
  };
}

function parseSettings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : {};
}
