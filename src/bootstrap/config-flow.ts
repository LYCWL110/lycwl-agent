import { type Instance, type RenderOptions, render } from "ink";
import { createElement, type ReactElement } from "react";
import type { ConfigDocument, ConfigStore } from "../adapters/windows/config-store.ts";
import type { FileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import {
  type ProviderConfig,
  readProviderConfig,
  SUPPORTED_PROTOCOLS,
  type SupportedProtocol,
  validateProviderConfig,
} from "../domain/config/provider-config.ts";
import {
  addCustomModel,
  applyKey,
  type BrowserState,
  createBrowserState,
  filteredModels,
  mergeFetchedModels,
} from "../tui/config-browser.ts";
import { ConfigBrowser } from "../tui/config-browser-view.ts";
import { type Capabilities, detectCapabilities } from "../tui/palette.ts";
import { type SetupDraft, type SetupField, SetupScreen } from "../tui/setup-screen.ts";
import { saveSetup } from "./setup-save.ts";

export type ConfigFlowOptions = Readonly<{
  configStore: ConfigStore;
  vault: FileVault;
  workspaceRoot: string;
  dataDirectory: string;
  onReady: (lines: readonly string[]) => void;
  onDiscard: () => void;
  save?: typeof saveSetup;
  capabilities?: Capabilities;
  /** Mount boundary for exercising the real save flow without a terminal. */
  mount?: (element: ReactElement, options: RenderOptions) => Pick<Instance, "rerender" | "unmount">;
  fetchModels?: (input: {
    protocol: SupportedProtocol;
    baseUrl: string;
    apiKey: string;
  }) => Promise<readonly string[] | Readonly<{ ok: false; code: string }>>;
}>;

export type ConfigFlow = Readonly<{
  done: Promise<"saved" | "discarded">;
  unmount: () => void;
}>;

type Phase = Readonly<{ kind: "setup" }> | Readonly<{ kind: "browser"; state: BrowserState }>;

/** One active input handler; saved selections apply only to the next Run. */
export function startConfigFlow(options: ConfigFlowOptions): ConfigFlow {
  const save = options.save ?? saveSetup;
  const capabilities =
    options.capabilities ??
    detectCapabilities({
      noColor: process.env["NO_COLOR"] !== undefined,
      colorterm: process.env["COLORTERM"],
      term: process.env["TERM"],
      force: process.env["LYCWL_COLOR"],
      windowsTerminal: process.env["WT_SESSION"] !== undefined,
    });
  let instance: Pick<Instance, "rerender" | "unmount"> | null = null;
  let settle: (outcome: "saved" | "discarded") => void = () => undefined;
  const done = new Promise<"saved" | "discarded">((resolve) => {
    settle = resolve;
  });
  let closed = false;
  let busy = false;
  let fetchVersion = 0;
  let phase: Phase = { kind: "setup" };
  let draft: SetupDraft = {
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    model: "",
    credentialRef: "provider-main",
    apiKey: "",
  };
  let baseDocument: ConfigDocument | null = null;
  let savedConfig: ProviderConfig | null = null;
  let hasStoredCredential = false;
  let error: Readonly<{ field: SetupField; code: string }> | null = null;
  let saveError: string | null = null;

  function redraw(): void {
    if (!closed) instance?.rerender(element());
  }

  function close(outcome: "saved" | "discarded"): void {
    if (closed) return;
    closed = true;
    fetchVersion += 1;
    instance?.unmount();
    if (outcome === "discarded") options.onDiscard();
    settle(outcome);
  }

  function element(): ReactElement {
    if (phase.kind === "setup") {
      return createElement(SetupScreen, {
        initial: draft,
        hasStoredCredential,
        capabilities,
        animated: true,
        busy,
        error,
        saveError,
        warnings: ["credentials are stored unencrypted"],
        onBrowse: (value: SetupDraft) => {
          if (busy || closed) return;
          draft = value;
          phase = {
            kind: "browser",
            state: createBrowserState({
              providerLabel: providerLabel(value.baseUrl),
              protocols: SUPPORTED_PROTOCOLS,
              currentProtocol: value.protocol ?? "anthropic_messages",
              models: value.model ? [value.model] : [],
              currentModel: value.model,
              reasoningEffort: value.reasoningEffort ?? "default",
            }),
          };
          redraw();
          void fetchModels(value.protocol ?? "anthropic_messages");
        },
        onSave: (value: SetupDraft) => {
          void persist(value);
        },
        onDiscard: () => {
          if (!busy) close("discarded");
        },
      });
    }
    return createElement(ConfigBrowser, {
      state: phase.state,
      capabilities,
      animated: true,
      busy,
      endpoint: draft.baseUrl,
      onState: (state: BrowserState) => {
        if (busy || phase.kind !== "browser") return;
        const changedProtocol = state.protocolIndex !== phase.state.protocolIndex;
        phase = { kind: "browser", state };
        redraw();
        if (changedProtocol)
          void fetchModels(state.protocols[state.protocolIndex] as SupportedProtocol);
      },
      onEdit: () => {
        if (busy || phase.kind !== "browser") return;
        draft = {
          ...draft,
          protocol: phase.state.protocols[phase.state.protocolIndex] as SupportedProtocol,
          model: filteredModels(phase.state)[phase.state.modelIndex]?.id ?? draft.model,
          reasoningEffort: phase.state.reasoningEffort,
        };
        fetchVersion += 1;
        phase = { kind: "setup" };
        redraw();
      },
      onRefresh: () => {
        if (phase.kind === "browser")
          void fetchModels(phase.state.protocols[phase.state.protocolIndex] as SupportedProtocol);
      },
      onCommit: (value) => {
        void persist({
          ...draft,
          protocol: value.protocol as SupportedProtocol,
          model: value.model,
          reasoningEffort:
            value.reasoningEffort ??
            (phase.kind === "browser" ? phase.state.reasoningEffort : "default"),
        });
      },
      onCancel: () => {
        if (!busy) close("discarded");
      },
    });
  }

  async function persist(value: SetupDraft): Promise<void> {
    if (busy || closed) return;
    busy = true;
    fetchVersion += 1;
    draft = value;
    error = null;
    saveError = null;
    redraw();
    try {
      const result = await save({
        draft: value,
        vault: options.vault,
        store: options.configStore,
        baseDocument,
      });
      if (closed) return;
      if (!result.ok) {
        saveError = result.detail ?? result.code;
        error = result.field === undefined ? null : { field: result.field, code: saveError };
        if (phase.kind === "browser") {
          phase = {
            kind: "browser",
            state: { ...phase.state, status: { text: `Save failed: ${saveError}`, isError: true } },
          };
        }
        return;
      }
      options.onReady([
        `protocol: ${result.config.protocol}`,
        `model: ${result.config.model}`,
        `reasoning: ${result.config.reasoningEffort ?? "default"}`,
        `endpoint: ${result.config.baseUrl}`,
        "configuration saved; applies to the next Run",
      ]);
      close("saved");
    } catch {
      saveError = "configuration could not be saved";
      if (phase.kind === "browser") {
        phase = {
          kind: "browser",
          state: { ...phase.state, status: { text: saveError, isError: true } },
        };
      }
    } finally {
      busy = false;
      redraw();
    }
  }

  async function fetchModels(protocol: SupportedProtocol): Promise<void> {
    if (busy || closed || phase.kind !== "browser") return;
    const version = ++fetchVersion;
    function status(text: string, isError: boolean): void {
      if (closed || version !== fetchVersion || phase.kind !== "browser") return;
      phase = { kind: "browser", state: { ...phase.state, status: { text, isError } } };
      redraw();
    }
    if (options.fetchModels === undefined) {
      status("Model list unavailable; add a model manually", false);
      return;
    }
    const route = validateProviderConfig({
      protocol,
      baseUrl: draft.baseUrl,
      credentialRef: draft.credentialRef,
      model: draft.model.trim() || "model-list",
    });
    if (!route.ok) {
      status("Enter a valid HTTPS connection before loading models", true);
      return;
    }
    // An explicitly entered key belongs to this draft destination. A stored key
    // must never follow an edited URL or credential reference automatically.
    if (
      draft.apiKey === "" &&
      (savedConfig === null ||
        route.value.baseUrl !== savedConfig.baseUrl ||
        draft.credentialRef !== savedConfig.credentialRef)
    ) {
      status("Enter an API key for this connection before loading models", true);
      return;
    }
    status("Loading models...", false);
    try {
      let apiKey = draft.apiKey;
      if (apiKey === "") {
        const key = await options.vault.read({
          reference: draft.credentialRef,
          purpose: "provider_api_key",
          revision: 1,
        });
        if (closed || version !== fetchVersion) return;
        if (!key.ok) {
          status("API key unavailable; edit the connection", true);
          return;
        }
        apiKey = key.value;
      }
      const result = await options.fetchModels({
        protocol,
        baseUrl: route.value.baseUrl,
        apiKey,
      });
      if (closed || version !== fetchVersion || phase.kind !== "browser") return;
      if ("ok" in result) {
        const message =
          result.code === "not_supported"
            ? "This endpoint does not list models; add a model manually"
            : "Model list unavailable; check the connection or add a model manually";
        status(message, true);
        return;
      }
      phase = { kind: "browser", state: mergeFetchedModels(phase.state, result) };
    } catch {
      if (closed || version !== fetchVersion || phase.kind !== "browser") return;
      phase = {
        kind: "browser",
        state: { ...phase.state, status: { text: "Model list unavailable", isError: true } },
      };
    }
    redraw();
  }

  async function initialize(): Promise<void> {
    try {
      const loaded = await options.configStore.load();
      if (closed) return;
      if (loaded.ok) {
        baseDocument = loaded.value;
        const parsed = parseJsonc(loaded.value.text);
        const config = readProviderConfig(parsed.ok ? toPlainValue(parsed.value) : {});
        if (config.ok) {
          savedConfig = config.value;
          draft = { ...config.value, apiKey: "" };
          const key = await options.vault.read({
            reference: config.value.credentialRef,
            purpose: "provider_api_key",
            revision: 1,
          });
          if (closed) return;
          hasStoredCredential = key.ok;
        }
      } else if (loaded.code !== "config_missing") {
        saveError = loaded.code;
      }
    } catch {
      saveError = "configuration could not be loaded";
    }
    if (closed) return;
    instance = (options.mount ?? render)(element(), { alternateScreen: true });
  }

  void initialize();
  return { done, unmount: () => close("discarded") };
}

function providerLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "Provider";
  }
}

export async function hasProvider(configStore: ConfigStore): Promise<boolean> {
  const loaded = await configStore.load();
  if (!loaded.ok) return false;
  const parsed = parseJsonc(loaded.value.text);
  return parsed.ok && readProviderConfig(toPlainValue(parsed.value)).ok;
}

export { applyKey, addCustomModel };
