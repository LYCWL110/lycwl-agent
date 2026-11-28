export const DEFAULT_CONTEXT_WINDOW = 272_000;
export function isContextWindow(value) {
    return (typeof value === "number" && Number.isSafeInteger(value) && value >= 8_192 && value <= 4_000_000);
}
export function resolveModelContext(model, manual) {
    if (isContextWindow(manual))
        return { contextWindow: manual, contextWindowSource: "manual" };
    if (!model?.contextWindowInvalid && isContextWindow(model?.contextWindow))
        return { contextWindow: model.contextWindow, contextWindowSource: "upstream" };
    return { contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowSource: "default" };
}
