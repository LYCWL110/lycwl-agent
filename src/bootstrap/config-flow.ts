import { type Instance, render } from "ink";
import { createElement, type ReactElement } from "react";
import type { ConfigStore } from "../adapters/windows/config-store.ts";
import type { FileVault } from "../adapters/windows/file-credential-vault.ts";
import { describeSelection, selectRuntime } from "../bootstrap/runtime-selection.ts";
import { type SaveSetupResult, saveSetup } from "../bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { SUPPORTED_PROTOCOLS, type SupportedProtocol } from "../domain/config/provider-config.ts";
import {
  addCustomModel,
  applyKey,
  type BrowserState,
  createBrowserState,
  mergeFetchedModels,
} from "../tui/config-browser.ts";
import { ConfigBrowser } from "../tui/config-browser-view.ts";
import { type Capabilities, detectCapabilities } from "../tui/palette.ts";
import { type SetupDraft, SetupScreen } from "../tui/setup-screen.ts";

/**
 * Configuration inside the TUI.
 *
 * Everything is configured here: there is no web page and no external editor. The
 * flow is setup (endpoint, model, credential) then the browser (protocol, model) and
 * back, reusing the same save path the first-run screen uses.
 *
 * The browser is mounted in place of the app rather than alongside it, because both
 * use Ink's `useInput` and two active handlers would compete for keystrokes.
 */

export type ConfigFlowOptions = Readonly<{
  configStore: ConfigStore;
  vault: FileVault;
  workspaceRoot: string;
  dataDirectory: string;
  /** Called with the message to print before the main TUI starts. */
  onReady: (lines: readonly string[]) => void;
  /** Called when the user leaves configuration without saving. */
  onDiscard: () => void;
  /** Injected for tests; production uses the real save path. */
  save?: typeof saveSetup;
  /** Injected for tests; production reads the real environment. */
  capabilities?: Capabilities;
  /** Injected for tests; production fetches from the provider. */
  fetchModels?: (input: {
    protocol: SupportedProtocol;
    baseUrl: string;
    apiKey: string;
  }) => Promise<readonly string[]>;
}>;

export type ConfigFlow = Readonly<{
  done: Promise<"saved" | "discarded">;
  unmount: () => void;
}>;

type Phase = Readonly<{ kind: "setup" }> | Readonly<{ kind: "browser"; state: BrowserState }>;

export function startConfigFlow(options: ConfigFlowOptions): ConfigFlow {
  const save = options.save ?? saveSetup;
  const capabilities =
    options.capabilities ??
    detectCapabilities({
      noColor: process.env["NO_COLOR"] !== undefined,
      colorterm: process.env["COLORTERM"],
      term: process.env["TERM"],
      force: process.env["LYCWL_COLOR"],
    });

  let instance: Instance | null = null;
  let settle: (outcome: "saved" | "discarded") => void = () => undefined;
  const done = new Promise<"saved" | "discarded">((resolve) => {
    settle = resolve;
  });

  let phase: Phase = { kind: "setup" };
  let error: Readonly<{
    field: "baseUrl" | "model" | "apiKey" | "credentialRef";
    code: string;
  }> | null = null;
  let busy = false;

  const element = (): ReactElement => {
    if (phase.kind === "setup") {
      return createElement(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error,
        warnings: ["credentials are stored unencrypted (ADR-0038)"],
        onSave: (draft: SetupDraft) => {
          if (busy) return;
          busy = true;
          void handleSave(draft);
        },
        onDiscard: () => {
          instance?.unmount();
          options.onDiscard();
          settle("discarded");
        },
      });
    }
    return createElement(ConfigBrowser, {
      state: phase.state,
      capabilities,
      onState: (state: BrowserState) => {
        phase = { kind: "browser", state };
        instance?.rerender(element());
      },
      onCommit: (value) => {
        void handleCommit(value);
      },
      onCancel: () => {
        instance?.unmount();
        options.onDiscard();
        settle("discarded");
      },
    });
  };

  async function handleSave(draft: SetupDraft): Promise<void> {
    const result: SaveSetupResult = await save({
      draft,
      vault: options.vault,
      store: options.configStore,
    });
    if (!result.ok) {
      error =
        result.field === undefined
          ? null
          : { field: result.field, code: result.detail ?? result.code };
      busy = false;
      instance?.rerender(element());
      return;
    }

    // Move to the browser so the user can pick a protocol and model before the
    // Session starts, which is what the first-run screen cannot do.
    error = null;
    busy = false;
    const savedProtocol = await readSavedProtocol();
    phase = {
      kind: "browser",
      state: createBrowserState({
        providerLabel: new URL(draft.baseUrl).hostname,
        protocols: [...SUPPORTED_PROTOCOLS],
        currentProtocol: savedProtocol,
        models: [draft.model],
        currentModel: draft.model,
      }),
    };
    instance?.rerender(element());
    void maybeFetchModels(draft, savedProtocol);
  }

  /** Fetch the provider's model list, keeping the browser usable on failure. */
  async function maybeFetchModels(draft: SetupDraft, protocol: SupportedProtocol): Promise<void> {
    if (options.fetchModels === undefined) return;
    const apiKey = await readKey(draft.credentialRef);
    if (apiKey === null) return;
    try {
      const models = await options.fetchModels({
        protocol,
        baseUrl: draft.baseUrl,
        apiKey,
      });
      if (phase.kind !== "browser") return;
      phase = { kind: "browser", state: mergeFetchedModels(phase.state, models) };
      instance?.rerender(element());
    } catch {
      // A fetch failure must not break configuration; the user can type a name.
      if (phase.kind !== "browser") return;
      phase = {
        kind: "browser",
        state: {
          ...phase.state,
          status: { text: "could not fetch the model list; type a name instead", isError: true },
        },
      };
      instance?.rerender(element());
    }
  }

  /** Read the protocol from the saved document, falling back to the default. */
  async function readSavedProtocol(): Promise<SupportedProtocol> {
    const loaded = await options.configStore.load();
    if (!loaded.ok) return SUPPORTED_PROTOCOLS[0];
    const settings = parseSettings(loaded.value.text) as {
      provider?: { protocol?: unknown };
    };
    const candidate = settings.provider?.protocol;
    return (SUPPORTED_PROTOCOLS as readonly string[]).includes(String(candidate))
      ? (candidate as SupportedProtocol)
      : SUPPORTED_PROTOCOLS[0];
  }

  async function readKey(reference: string): Promise<string | null> {
    const read = await options.vault.read({
      reference,
      purpose: "provider_api_key",
      revision: 1,
    });
    return read.ok ? read.value : null;
  }

  async function handleCommit(value: Readonly<{ protocol: string; model: string }>): Promise<void> {
    instance?.unmount();
    const loaded = await options.configStore.load();
    const settings = loaded.ok ? parseSettings(loaded.value.text) : null;
    const selection = await selectRuntime({
      workspaceRoot: options.workspaceRoot,
      dataDirectory: options.dataDirectory,
      settings,
      hasSettings: loaded.ok,
    });
    options.onReady([
      ...describeSelection(selection),
      `protocol: ${value.protocol}`,
      `model: ${value.model}`,
    ]);
    settle("saved");
  }

  instance = render(element());
  return { done, unmount: () => instance?.unmount() };
}

function parseSettings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : {};
}

/** Whether the saved settings already contain a provider block. */
export async function hasProvider(configStore: ConfigStore): Promise<boolean> {
  const loaded = await configStore.load();
  if (!loaded.ok) return false;
  const parsed = parseJsonc(loaded.value.text);
  if (!parsed.ok) return false;
  const settings = toPlainValue(parsed.value) as Record<string, unknown>;
  return settings["provider"] !== undefined;
}

export { applyKey, addCustomModel };
