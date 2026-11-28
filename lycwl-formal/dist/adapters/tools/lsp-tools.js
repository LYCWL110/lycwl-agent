import { boundLspText, canUseInstance, formatDiagnostics, formatLocations, normalizeDiagnostics, normalizeLocations, requiresReapproval, validateLspMessageSize, validatePosition, } from "../../domain/language/lsp.js";
export const LSP_DIAGNOSTICS_DEFINITION = {
    name: "lsp_diagnostics",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
export const LSP_DEFINITION_DEFINITION = {
    name: "lsp_definition",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
export const LSP_REFERENCES_DEFINITION = {
    name: "lsp_references",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
const DEFINITIONS = [
    LSP_DIAGNOSTICS_DEFINITION,
    LSP_DEFINITION_DEFINITION,
    LSP_REFERENCES_DEFINITION,
];
export function createLspTools(dependencies) {
    return {
        getDefinition(toolName) {
            return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
        },
        async execute(request) {
            if (!DEFINITIONS.some((definition) => definition.name === request.toolName)) {
                return { status: "failed", safeCode: "unknown_tool", text: null };
            }
            const instance = dependencies.getInstance();
            const usable = canUseInstance(instance);
            if (!usable.ok)
                return { status: "failed", safeCode: usable.code, text: null };
            if (requiresReapproval(usable.value, dependencies.getLiveIdentity())) {
                // A restarted process identity means the old approval no longer applies.
                return { status: "failed", safeCode: "instance_not_approved", text: null };
            }
            if (request.toolName === LSP_DIAGNOSTICS_DEFINITION.name) {
                return executeDiagnostics(dependencies, usable.value, request.arguments);
            }
            return executeLocations(dependencies, usable.value, request.toolName, request.arguments);
        },
    };
}
function readPath(args) {
    if (typeof args !== "object" || args === null) {
        return { ok: false, code: "invalid_arguments" };
    }
    const path = args["path"];
    if (typeof path !== "string" || path.length === 0) {
        return { ok: false, code: "invalid_arguments" };
    }
    return { ok: true, value: path };
}
async function executeDiagnostics(dependencies, instance, args) {
    const path = readPath(args);
    if (!path.ok)
        return { status: "failed", safeCode: path.code, text: null };
    const outcome = await dependencies.diagnostics(instance, path.value);
    if (outcome.kind === "unknown") {
        return { status: "outcome_unknown", safeCode: outcome.safeCode };
    }
    const size = validateLspMessageSize(outcome.messageBytes);
    if (!size.ok)
        return { status: "failed", safeCode: size.code, text: null };
    const normalized = normalizeDiagnostics(outcome.payload);
    if (!normalized.ok)
        return { status: "failed", safeCode: normalized.code, text: null };
    return { status: "succeeded", text: boundLspText(formatDiagnostics(normalized.value)) };
}
async function executeLocations(dependencies, instance, toolName, args) {
    if (typeof args !== "object" || args === null) {
        return { status: "failed", safeCode: "invalid_arguments", text: null };
    }
    const record = args;
    const path = readPath(args);
    if (!path.ok)
        return { status: "failed", safeCode: path.code, text: null };
    const position = validatePosition(record["position"]);
    if (!position.ok)
        return { status: "failed", safeCode: position.code, text: null };
    const call = toolName === LSP_DEFINITION_DEFINITION.name ? dependencies.definition : dependencies.references;
    const outcome = await call(instance, path.value, position.value);
    if (outcome.kind === "unknown") {
        return { status: "outcome_unknown", safeCode: outcome.safeCode };
    }
    const size = validateLspMessageSize(outcome.messageBytes);
    if (!size.ok)
        return { status: "failed", safeCode: size.code, text: null };
    const normalized = normalizeLocations(outcome.payload);
    if (!normalized.ok)
        return { status: "failed", safeCode: normalized.code, text: null };
    if (normalized.value.length === 0) {
        return { status: "succeeded", text: `${toolName}: no locations` };
    }
    return { status: "succeeded", text: boundLspText(formatLocations(toolName, normalized.value)) };
}
