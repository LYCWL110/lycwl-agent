import { type Instance, render } from "ink";
import { createElement, type ReactElement } from "react";
import type { ConfigStore } from "../adapters/windows/config-store.ts";
import type { FileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import type { App } from "../tui/app.ts";
import { createTuiController } from "../tui/controller.ts";
import { startTui } from "../tui/main.ts";
import { type SetupDraft, type SetupField, SetupScreen } from "../tui/setup-screen.ts";
import { describeSelection, selectRuntime } from "./runtime-selection.ts";
import { type SaveSetupResult, saveSetup } from "./setup-save.ts";

/**
 * Setup-then-run flow.
 *
 * The setup screen replaces the main app rather than rendering alongside it,
 * because both use Ink's `useInput` and two active input handlers would compete for
 * keystrokes. Mounting one at a time keeps the routing obvious.
 *
 * The first-time path is: no configuration -> setup screen -> save -> start the
 * runtime the saved configuration selects. The runtime selection is re-run after
 * saving rather than assumed, so a configuration that saved but cannot be assembled
 * reports that instead of opening a broken session.
 */

export type SetupFlowOptions = Readonly<{
  configStore: ConfigStore;
  vault: FileVault;
  workspaceRoot: string;
  dataDirectory: string;
  /** Called with the message to print before the main TUI starts. */
  onReady: (lines: readonly string[]) => void;
  /** Called when the user discards setup; the caller decides whether to exit. */
  onDiscard: () => void;
  /** Injected for tests; production uses the real save path. */
  save?: typeof saveSetup;
}>;

export type SetupFlow = Readonly<{
  /** Resolve when the flow ends, either by saving or discarding. */
  done: Promise<"saved" | "discarded">;
  unmount: () => void;
}>;

export function startSetupFlow(options: SetupFlowOptions): SetupFlow {
  const save = options.save ?? saveSetup;
  let instance: Instance | null = null;
  let settle: (outcome: "saved" | "discarded") => void = () => undefined;
  const done = new Promise<"saved" | "discarded">((resolve) => {
    settle = resolve;
  });

  let error: Readonly<{ field: SetupField; code: string }> | null = null;
  let busy = false;

  const element = (): ReactElement =>
    createElement(SetupScreen, {
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

  async function handleSave(draft: SetupDraft): Promise<void> {
    const result: SaveSetupResult = await save({
      draft,
      vault: options.vault,
      store: options.configStore,
    });

    if (!result.ok) {
      // Keep the draft on screen: the user typed it, and a save failure must not
      // erase their input. A failure without a field (for example a config
      // conflict) is shown as a warning line instead of a field error.
      error =
        result.field === undefined
          ? null
          : { field: result.field, code: result.detail ?? result.code };
      busy = false;
      instance?.rerender(element());
      return;
    }

    instance?.unmount();

    // Re-select from what was actually written, not from the draft.
    const loaded = await options.configStore.load();
    const settings = loaded.ok ? parseSettings(loaded.value.text) : null;
    const selection = await selectRuntime({
      workspaceRoot: options.workspaceRoot,
      dataDirectory: options.dataDirectory,
      settings,
      hasSettings: loaded.ok,
    });
    options.onReady(describeSelection(selection));
    startTui(createTuiController({ coordinator: selection.coordinator }));
    settle("saved");
  }

  instance = render(element());
  return { done, unmount: () => instance?.unmount() };
}

/** Whether the saved settings are complete enough to skip setup. */
export async function needsSetup(configStore: ConfigStore): Promise<boolean> {
  const loaded = await configStore.load();
  if (!loaded.ok) return true;
  const parsed = parseJsonc(loaded.value.text);
  if (!parsed.ok) return true;
  const settings = toPlainValue(parsed.value) as Record<string, unknown>;
  return settings["provider"] === undefined;
}

function parseSettings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : {};
}

export type { App };
