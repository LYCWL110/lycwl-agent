import { MEMORY_LIMITS, MEMORY_TYPES, renderMemoryMatches, searchMemory, } from "../../domain/memory/memory.js";
export const MEMORY_SEARCH_NAME = "memory_search";
export const MEMORY_SEARCH_DEFINITION = {
    name: MEMORY_SEARCH_NAME,
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: true,
};
export function createMemorySearchTool(dependencies) {
    return {
        getDefinition(toolName) {
            return toolName === MEMORY_SEARCH_NAME ? MEMORY_SEARCH_DEFINITION : null;
        },
        async preview() {
            return null;
        },
        async execute(request) {
            const args = typeof request.arguments === "object" && request.arguments !== null
                ? request.arguments
                : {};
            const query = args["query"];
            if (typeof query !== "string" || query.trim().length === 0) {
                return { status: "failed", safeCode: "invalid_arguments", text: null };
            }
            if (query.length > 200) {
                return { status: "failed", safeCode: "query_too_long", text: null };
            }
            const rawTypes = args["types"];
            let types;
            if (rawTypes !== undefined) {
                if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
                    return { status: "failed", safeCode: "invalid_arguments", text: null };
                }
                if (rawTypes.some((value) => typeof value !== "string" || !MEMORY_TYPES.includes(value))) {
                    return { status: "failed", safeCode: "invalid_arguments", text: null };
                }
                types = rawTypes;
            }
            const rawLimit = args["limit"];
            const limit = typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit > 0
                ? Math.min(rawLimit, MEMORY_LIMITS.maxContextEntries)
                : MEMORY_LIMITS.maxContextEntries;
            const loaded = await dependencies.store.load();
            if (!loaded.ok) {
                return { status: "failed", safeCode: "memory_unavailable", text: null };
            }
            const matches = searchMemory(loaded.entries, {
                query,
                projectRoot: dependencies.projectRoot,
                nowUtc: dependencies.nowUtc(),
                ...(types === undefined ? {} : { types }),
                limit,
            });
            return { status: "succeeded", text: renderMemoryMatches(matches) };
        },
    };
}
