import { render } from "ink";
import { createElement } from "react";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.js";
import { createTuiController } from "../tui/controller.js";
import { startTui } from "../tui/main.js";
import { SetupScreen } from "../tui/setup-screen.js";
import { describeSelection, selectRuntime } from "./runtime-selection.js";
import { saveSetup } from "./setup-save.js";
export function startSetupFlow(options) {
    const save = options.save ?? saveSetup;
    let instance = null;
    let settle = () => undefined;
    const done = new Promise((resolve) => {
        settle = resolve;
    });
    let error = null;
    let busy = false;
    const element = () => createElement(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error,
        warnings: ["credentials are stored unencrypted (ADR-0038)"],
        onSave: (draft) => {
            if (busy)
                return;
            busy = true;
            void handleSave(draft);
        },
        onDiscard: () => {
            instance?.unmount();
            options.onDiscard();
            settle("discarded");
        },
    });
    async function handleSave(draft) {
        const result = await save({
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
        startTui(createTuiController({
            coordinator: selection.coordinator,
            ...(selection.kind === "real" ? { memory: selection.memory } : {}),
            workspaceRoot: options.workspaceRoot,
        }));
        settle("saved");
    }
    instance = render(element());
    return { done, unmount: () => instance?.unmount() };
}
/** Whether the saved settings are complete enough to skip setup. */
export async function needsSetup(configStore) {
    const loaded = await configStore.load();
    if (!loaded.ok)
        return true;
    const parsed = parseJsonc(loaded.value.text);
    if (!parsed.ok)
        return true;
    const settings = toPlainValue(parsed.value);
    return settings["provider"] === undefined;
}
function parseSettings(text) {
    const parsed = parseJsonc(text);
    return parsed.ok ? toPlainValue(parsed.value) : {};
}
