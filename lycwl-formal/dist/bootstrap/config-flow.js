import { render } from "ink";
import { createElement } from "react";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.js";
import { DEFAULT_CONTEXT_WINDOW, isContextWindow, resolveModelContext, } from "../domain/config/model-context.js";
import { readProviderConfig, SUPPORTED_PROTOCOLS, validateProviderConfig, } from "../domain/config/provider-config.js";
import { addCustomModel, applyKey, clearReasoningDeclarations, createBrowserState, filteredModels, mergeFetchedModels, reasoningChoices, } from "../tui/config-browser.js";
import { ConfigBrowser } from "../tui/config-browser-view.js";
import { detectCapabilities } from "../tui/palette.js";
import { SetupScreen } from "../tui/setup-screen.js";
import { saveSetup } from "./setup-save.js";
/** One active input handler; saved selections apply only to the next Run. */
export function startConfigFlow(options) {
    const save = options.save ?? saveSetup;
    const capabilities = options.capabilities ??
        detectCapabilities({
            noColor: process.env["NO_COLOR"] !== undefined,
            colorterm: process.env["COLORTERM"],
            term: process.env["TERM"],
            force: process.env["LYCWL_COLOR"],
            windowsTerminal: process.env["WT_SESSION"] !== undefined,
        });
    let instance = null;
    let settle = () => undefined;
    const done = new Promise((resolve) => {
        settle = resolve;
    });
    let closed = false;
    let busy = false;
    let fetchVersion = 0;
    let listPending = false;
    let detailVersion = 0;
    let selectionVersion = 0;
    let detailTimer = null;
    const detailCache = new Map();
    let catalogSnapshot = null;
    let phase = { kind: "setup" };
    let draft = {
        protocol: "anthropic_messages",
        baseUrl: "https://api.anthropic.com",
        model: "",
        credentialRef: "provider-main",
        apiKey: "",
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        contextWindowSource: "default",
    };
    let baseDocument = null;
    let savedConfig = null;
    let hasStoredCredential = false;
    let error = null;
    let saveError = null;
    function redraw() {
        if (!closed)
            instance?.rerender(element());
    }
    function close(outcome) {
        if (closed)
            return;
        closed = true;
        fetchVersion += 1;
        clearDetails();
        catalogSnapshot = null;
        instance?.unmount();
        if (outcome === "discarded")
            options.onDiscard();
        settle(outcome);
    }
    function browse(value, column = "model") {
        if (busy || closed)
            return;
        draft = value;
        phase = {
            kind: "browser",
            state: {
                ...createBrowserState({
                    providerLabel: providerLabel(value.baseUrl),
                    protocols: SUPPORTED_PROTOCOLS,
                    currentProtocol: value.protocol ?? "anthropic_messages",
                    models: value.model ? [value.model] : [],
                    currentModel: value.model,
                    reasoningEffort: value.reasoningEffort ?? "default",
                }),
                activeColumn: column,
            },
        };
        redraw();
        void fetchModels(value.protocol ?? "anthropic_messages", true);
    }
    function element() {
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
                onBrowse: browse,
                onSave: (value) => {
                    // A form save with an explicit effort must pass through catalog selection.
                    if (value.reasoningEffort !== undefined && value.reasoningEffort !== "default") {
                        browse(value, "reasoning");
                        return;
                    }
                    void persist(value);
                },
                onDiscard: () => {
                    if (!busy)
                        close("discarded");
                },
            });
        }
        return createElement(ConfigBrowser, {
            state: phase.state,
            ...(hasManualContext(draft) && isContextWindow(Number(draft.contextWindow))
                ? { contextOverride: Number(draft.contextWindow) }
                : {}),
            capabilities,
            animated: true,
            busy,
            endpoint: draft.baseUrl,
            onState: (state) => {
                if (busy || phase.kind !== "browser")
                    return;
                const changedProtocol = state.protocolIndex !== phase.state.protocolIndex;
                const changedModel = filteredModels(state)[state.modelIndex]?.id !==
                    filteredModels(phase.state)[phase.state.modelIndex]?.id;
                if (changedProtocol ||
                    changedModel ||
                    state.reasoningEffort !== phase.state.reasoningEffort)
                    selectionVersion += 1;
                phase = { kind: "browser", state };
                redraw();
                if (changedProtocol)
                    void fetchModels(state.protocols[state.protocolIndex]);
                else if (changedModel)
                    scheduleDetails();
            },
            onEdit: () => {
                if (busy || phase.kind !== "browser")
                    return;
                const selectedModel = filteredModels(phase.state)[phase.state.modelIndex];
                const changedModel = selectedModel?.id !== draft.model ||
                    phase.state.protocols[phase.state.protocolIndex] !== draft.protocol;
                draft = {
                    ...draft,
                    ...contextForDraft(changedModel && !hasManualContext(draft)
                        ? { ...draft, contextWindowSource: "default" }
                        : draft, selectedModel),
                    protocol: phase.state.protocols[phase.state.protocolIndex],
                    model: filteredModels(phase.state)[phase.state.modelIndex]?.id ?? draft.model,
                    reasoningEffort: phase.state.reasoningEffort,
                };
                if (selectedModel !== undefined) {
                    const scope = catalogScope(draft);
                    const models = catalogSnapshot?.scope === scope ? catalogSnapshot.models : [];
                    catalogSnapshot = {
                        scope,
                        models: [
                            ...models.filter((entry) => (typeof entry === "string" ? entry : entry.id) !== selectedModel.id),
                            selectedModel,
                        ],
                    };
                }
                fetchVersion += 1;
                clearDetails();
                phase = { kind: "setup" };
                redraw();
            },
            onRefresh: () => {
                if (phase.kind === "browser")
                    void fetchModels(phase.state.protocols[phase.state.protocolIndex]);
            },
            onCommit: async (value) => {
                if (busy || closed || phase.kind !== "browser")
                    return;
                if (listPending && options.fetchModel !== undefined) {
                    phase = {
                        kind: "browser",
                        state: {
                            ...phase.state,
                            status: { text: "Model list is loading; select again when ready", isError: false },
                        },
                    };
                    redraw();
                    return;
                }
                let selected = phase.kind === "browser"
                    ? {
                        ...(value.protocol === phase.state.protocols[phase.state.protocolIndex]
                            ? phase.state
                            : clearReasoningDeclarations(phase.state)),
                        protocolIndex: phase.state.protocols.indexOf(value.protocol),
                        modelIndex: filteredModels(phase.state).findIndex((model) => model.id === value.model),
                    }
                    : null;
                if (selected === null ||
                    !reasoningChoices(selected).includes(value.reasoningEffort ?? selected.reasoningEffort)) {
                    if (phase.kind === "browser") {
                        phase = {
                            kind: "browser",
                            state: {
                                ...phase.state,
                                status: { text: "Select a listed reasoning level before saving", isError: true },
                            },
                        };
                        redraw();
                    }
                    return;
                }
                if (options.fetchModel !== undefined &&
                    !(hasManualContext(draft) &&
                        filteredModels(phase.state)[phase.state.modelIndex]?.reasoning !== undefined) &&
                    filteredModels(phase.state)[phase.state.modelIndex]?.id === value.model &&
                    phase.state.protocols[phase.state.protocolIndex] === value.protocol) {
                    const version = fetchVersion;
                    const detail = detailVersion;
                    const selection = selectionVersion;
                    if (detailTimer !== null)
                        clearTimeout(detailTimer);
                    detailTimer = null;
                    await fetchSelectedDetails();
                    if (closed ||
                        busy ||
                        version !== fetchVersion ||
                        detail !== detailVersion ||
                        selection !== selectionVersion ||
                        phase.kind !== "browser" ||
                        filteredModels(phase.state)[phase.state.modelIndex]?.id !== value.model ||
                        phase.state.protocols[phase.state.protocolIndex] !== value.protocol)
                        return;
                    selected = phase.state;
                    if (!reasoningChoices(selected).includes(value.reasoningEffort ?? selected.reasoningEffort)) {
                        phase = {
                            kind: "browser",
                            state: {
                                ...phase.state,
                                status: { text: "Select a listed reasoning level before saving", isError: true },
                            },
                        };
                        redraw();
                        return;
                    }
                }
                const changedModel = value.model !== draft.model || value.protocol !== draft.protocol;
                void persist({
                    ...draft,
                    ...contextForDraft(changedModel && !hasManualContext(draft)
                        ? { ...draft, contextWindowSource: "default" }
                        : draft, filteredModels(selected)[selected.modelIndex]),
                    protocol: value.protocol,
                    model: value.model,
                    reasoningEffort: value.reasoningEffort ??
                        (phase.kind === "browser" ? phase.state.reasoningEffort : "default"),
                }, true);
            },
            onCancel: () => {
                if (!busy)
                    close("discarded");
            },
        });
    }
    function hasManualContext(value) {
        return (value.contextWindowSource === "manual" ||
            (value.contextWindowSource === undefined &&
                value.contextWindow !== undefined &&
                value.contextWindow !== null &&
                value.contextWindow !== ""));
    }
    function catalogScope(value, protocol = value.protocol ?? "anthropic_messages") {
        return JSON.stringify([
            protocol,
            value.baseUrl.replace(/\/+$/, ""),
            value.credentialRef,
            value.apiKey,
        ]);
    }
    function contextForDraft(value, model) {
        if (hasManualContext(value))
            return {
                ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
                contextWindowSource: "manual",
            };
        return resolveModelContext(model);
    }
    async function persist(value, metadataResolved = false) {
        if (busy || closed)
            return;
        busy = true;
        fetchVersion += 1;
        clearDetails();
        draft = value;
        error = null;
        saveError = null;
        redraw();
        try {
            if (!metadataResolved) {
                const scope = catalogScope(value);
                const cached = catalogSnapshot?.scope === scope
                    ? catalogSnapshot.models.find((entry) => typeof entry !== "string" && entry.id === value.model)
                    : undefined;
                let model = typeof cached === "object" ? cached : undefined;
                if (!hasManualContext(value) &&
                    !isContextWindow(model?.contextWindow) &&
                    (options.fetchModels !== undefined || options.fetchModel !== undefined)) {
                    const current = () => !closed;
                    const connection = await catalogConnection(value.protocol ?? "anthropic_messages", current, () => undefined);
                    if (connection !== null && !closed) {
                        const request = { ...connection, protocol: value.protocol ?? "anthropic_messages" };
                        if (!isContextWindow(model?.contextWindow) && options.fetchModels !== undefined) {
                            try {
                                const listed = await options.fetchModels(request);
                                if (!("ok" in listed)) {
                                    const found = listed.find((entry) => typeof entry !== "string" && entry.id === value.model);
                                    if (typeof found === "object")
                                        model = found;
                                }
                            }
                            catch {
                                model = undefined;
                            }
                        }
                        if (!closed &&
                            !isContextWindow(model?.contextWindow) &&
                            options.fetchModel !== undefined) {
                            try {
                                const details = await options.fetchModel({ ...request, model: value.model });
                                if (details.ok && details.model.id === value.model)
                                    model = details.model;
                            }
                            catch {
                                /* Unavailable metadata uses the explicit default below. */
                            }
                        }
                    }
                }
                if (closed)
                    return;
                value = { ...value, ...contextForDraft(value, model) };
                draft = value;
            }
            const result = await save({
                draft: value,
                vault: options.vault,
                store: options.configStore,
                baseDocument,
            });
            if (closed)
                return;
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
                `context: ${draft.contextWindow} tokens (${draft.contextWindowSource ?? "manual"})`,
                `endpoint: ${result.config.baseUrl}`,
                "configuration saved; applies to the next Run",
            ]);
            close("saved");
        }
        catch {
            saveError = "configuration could not be saved";
            if (phase.kind === "browser") {
                phase = {
                    kind: "browser",
                    state: { ...phase.state, status: { text: saveError, isError: true } },
                };
            }
        }
        finally {
            busy = false;
            redraw();
        }
    }
    async function catalogConnection(protocol, current, status) {
        const route = validateProviderConfig({
            protocol,
            baseUrl: draft.baseUrl,
            credentialRef: draft.credentialRef,
            model: draft.model.trim() || "model-list",
        });
        if (!route.ok) {
            status("Enter a valid HTTPS connection before loading models", true);
            return null;
        }
        // An explicitly entered key belongs to this draft destination. A stored key
        // must never follow an edited URL or credential reference automatically.
        if (draft.apiKey === "" &&
            (savedConfig === null ||
                route.value.baseUrl !== savedConfig.baseUrl ||
                draft.credentialRef !== savedConfig.credentialRef)) {
            status("Enter an API key for this connection before loading models", true);
            return null;
        }
        if (draft.apiKey !== "")
            return { baseUrl: route.value.baseUrl, apiKey: draft.apiKey };
        const key = await options.vault.read({
            reference: draft.credentialRef,
            purpose: "provider_api_key",
            revision: 1,
        });
        if (!current())
            return null;
        if (!key.ok) {
            status("API key unavailable; edit the connection", true);
            return null;
        }
        return { baseUrl: route.value.baseUrl, apiKey: key.value };
    }
    async function fetchModels(protocol, retainContext = false) {
        if (busy || closed || phase.kind !== "browser")
            return;
        const retained = retainContext && catalogSnapshot?.scope === catalogScope(draft, protocol)
            ? catalogSnapshot
            : null;
        phase = { kind: "browser", state: clearReasoningDeclarations(phase.state) };
        if (retained !== null) {
            phase = {
                kind: "browser",
                state: {
                    ...phase.state,
                    models: phase.state.models.map((model) => {
                        const previous = retained.models.find((entry) => typeof entry !== "string" && entry.id === model.id);
                        return typeof previous === "object" &&
                            previous.contextWindow !== undefined &&
                            !previous.contextWindowInvalid
                            ? { ...model, contextWindow: previous.contextWindow }
                            : model;
                    }),
                },
            };
        }
        catalogSnapshot = retained;
        clearDetails();
        const version = ++fetchVersion;
        listPending = true;
        redraw();
        const current = () => !closed && version === fetchVersion && phase.kind === "browser";
        function status(text, isError) {
            if (!current() || phase.kind !== "browser")
                return;
            phase = { kind: "browser", state: { ...phase.state, status: { text, isError } } };
            redraw();
        }
        try {
            if (options.fetchModels === undefined) {
                status("Model list unavailable; add a model manually", false);
                return;
            }
            const connection = await catalogConnection(protocol, current, status);
            if (connection === null || !current())
                return;
            status("Loading models...", false);
            const result = await options.fetchModels({ protocol, ...connection });
            if (closed || version !== fetchVersion || phase.kind !== "browser")
                return;
            if ("ok" in result) {
                const message = result.code === "not_supported"
                    ? "This endpoint does not list models; add a model manually"
                    : "Model list unavailable; check the connection or add a model manually";
                status(message, true);
                return;
            }
            phase = { kind: "browser", state: mergeFetchedModels(phase.state, result) };
            if (retained !== null) {
                phase = {
                    kind: "browser",
                    state: {
                        ...phase.state,
                        models: phase.state.models.map((model) => {
                            if (model.contextWindow !== undefined || model.contextWindowInvalid)
                                return model;
                            const previous = retained.models.find((entry) => typeof entry !== "string" && entry.id === model.id);
                            return typeof previous === "object" &&
                                previous.contextWindow !== undefined &&
                                !previous.contextWindowInvalid
                                ? { ...model, contextWindow: previous.contextWindow }
                                : model;
                        }),
                    },
                };
            }
            catalogSnapshot = { scope: catalogScope(draft, protocol), models: phase.state.models };
        }
        catch {
            if (closed || version !== fetchVersion || phase.kind !== "browser")
                return;
            phase = {
                kind: "browser",
                state: { ...phase.state, status: { text: "Model list unavailable", isError: true } },
            };
        }
        finally {
            if (current()) {
                listPending = false;
                redraw();
                scheduleDetails();
            }
        }
    }
    function clearDetails() {
        detailVersion += 1;
        if (detailTimer !== null)
            clearTimeout(detailTimer);
        detailTimer = null;
        detailCache.clear();
    }
    function scheduleDetails() {
        if (detailTimer !== null)
            clearTimeout(detailTimer);
        detailTimer = null;
        detailVersion += 1;
        if (closed ||
            busy ||
            listPending ||
            phase.kind !== "browser" ||
            options.fetchModel === undefined)
            return;
        const model = filteredModels(phase.state)[phase.state.modelIndex];
        if (model === undefined ||
            (model.reasoning !== undefined &&
                (options.discoverContextOnSelection !== true ||
                    hasManualContext(draft) ||
                    model.contextWindow !== undefined)))
            return;
        // Settle keyboard navigation before issuing a lookup for the selected model.
        detailTimer = setTimeout(() => {
            detailTimer = null;
            void fetchSelectedDetails();
        }, 120);
    }
    async function fetchSelectedDetails() {
        const fetchModel = options.fetchModel;
        if (phase.kind !== "browser" || fetchModel === undefined || closed || busy)
            return;
        const selected = filteredModels(phase.state)[phase.state.modelIndex];
        if (selected === undefined ||
            (selected.reasoning !== undefined &&
                (selected.contextWindow !== undefined || hasManualContext(draft))))
            return;
        const protocol = phase.state.protocols[phase.state.protocolIndex];
        const version = fetchVersion;
        const detail = detailVersion;
        const routeCurrent = () => !closed && !busy && version === fetchVersion && phase.kind === "browser";
        const current = () => routeCurrent() &&
            detail === detailVersion &&
            phase.kind === "browser" &&
            filteredModels(phase.state)[phase.state.modelIndex]?.id === selected.id &&
            phase.state.protocols[phase.state.protocolIndex] === protocol;
        function status(text, isError) {
            if (!current() || phase.kind !== "browser")
                return;
            phase = { kind: "browser", state: { ...phase.state, status: { text, isError } } };
            redraw();
        }
        const cacheKey = JSON.stringify([protocol, selected.id]);
        let pending = detailCache.get(cacheKey);
        if (pending === undefined) {
            status("Loading model details...", false);
            pending = (async () => {
                try {
                    const connection = await catalogConnection(protocol, routeCurrent, status);
                    if (connection === null || !routeCurrent())
                        return { ok: false, code: "connection_unavailable" };
                    return await fetchModel({ protocol, ...connection, model: selected.id });
                }
                catch {
                    return { ok: false, code: "fetch_failed" };
                }
            })();
            detailCache.set(cacheKey, pending);
            const oldest = detailCache.keys().next().value;
            if (detailCache.size > 64 && oldest !== undefined)
                detailCache.delete(oldest);
        }
        const result = await pending;
        if (!current() || phase.kind !== "browser")
            return;
        if (!result.ok && result.code === "connection_unavailable")
            return;
        if (!result.ok || result.model.id !== selected.id) {
            // A provider that answers 200 with an error body is saying something more
            // specific than "unreadable", and the two lead to different actions.
            status(!result.ok && result.code === "model_not_found"
                ? "Model details unavailable: the provider reports no such model"
                : "Model details unavailable; support unknown", true);
            return;
        }
        const reasoning = selected.reasoning ?? result.model.reasoning;
        const invalid = selected.reasoning !== undefined
            ? selected.reasoningInvalid === true
            : result.model.reasoningInvalid === true ||
                (result.model.reasoning === undefined && selected.reasoningInvalid === true);
        const context = selected.contextWindow === undefined &&
            (result.model.contextWindow !== undefined || result.model.contextWindowInvalid)
            ? {
                ...(result.model.contextWindow === undefined
                    ? {}
                    : { contextWindow: result.model.contextWindow }),
                ...(result.model.contextWindowInvalid ? { contextWindowInvalid: true } : {}),
            }
            : {
                ...(selected.contextWindow === undefined
                    ? {}
                    : { contextWindow: selected.contextWindow }),
                ...(selected.contextWindowInvalid ? { contextWindowInvalid: true } : {}),
            };
        if (reasoning === undefined &&
            !invalid &&
            context.contextWindow === undefined &&
            !context.contextWindowInvalid) {
            status("Model details do not declare effort levels", false);
            return;
        }
        phase = {
            kind: "browser",
            state: {
                ...phase.state,
                models: phase.state.models.map((entry) => entry.id === selected.id
                    ? {
                        id: entry.id,
                        source: entry.source,
                        ...context,
                        ...(reasoning === undefined ? {} : { reasoning }),
                        ...(invalid ? { reasoningInvalid: true } : {}),
                    }
                    : entry),
                undo: null,
                status: {
                    text: invalid ? "Invalid upstream levels; support unknown" : "Model details loaded",
                    isError: invalid,
                },
            },
        };
        redraw();
    }
    async function initialize() {
        try {
            const loaded = await options.configStore.load();
            if (closed)
                return;
            if (loaded.ok) {
                baseDocument = loaded.value;
                const parsed = parseJsonc(loaded.value.text);
                const config = readProviderConfig(parsed.ok ? toPlainValue(parsed.value) : {});
                if (config.ok) {
                    savedConfig = config.value;
                    draft = {
                        ...config.value,
                        apiKey: "",
                        ...(config.value.contextWindow === null ? resolveModelContext(undefined) : {}),
                    };
                    const key = await options.vault.read({
                        reference: config.value.credentialRef,
                        purpose: "provider_api_key",
                        revision: 1,
                    });
                    if (closed)
                        return;
                    hasStoredCredential = key.ok;
                }
            }
            else if (loaded.code !== "config_missing") {
                saveError = loaded.code;
            }
        }
        catch {
            saveError = "configuration could not be loaded";
        }
        if (closed)
            return;
        if (options.initialPage === "model" && savedConfig !== null && hasStoredCredential) {
            phase = {
                kind: "browser",
                state: {
                    ...createBrowserState({
                        providerLabel: providerLabel(savedConfig.baseUrl),
                        protocols: SUPPORTED_PROTOCOLS,
                        currentProtocol: savedConfig.protocol,
                        models: [savedConfig.model],
                        currentModel: savedConfig.model,
                        reasoningEffort: savedConfig.reasoningEffort ?? "default",
                    }),
                    activeColumn: "model",
                },
            };
        }
        instance = (options.mount ?? render)(element(), { alternateScreen: true });
        if (phase.kind === "browser")
            void fetchModels(savedConfig?.protocol ?? "anthropic_messages");
    }
    void initialize();
    return { done, unmount: () => close("discarded") };
}
function providerLabel(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    }
    catch {
        return "Provider";
    }
}
export async function hasProvider(configStore) {
    const loaded = await configStore.load();
    if (!loaded.ok)
        return false;
    const parsed = parseJsonc(loaded.value.text);
    return parsed.ok && readProviderConfig(toPlainValue(parsed.value)).ok;
}
export { applyKey, addCustomModel };
