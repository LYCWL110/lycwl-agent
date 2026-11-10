import { evaluateIgnoreWithAncestors } from "../../domain/search/ignore-rules.js";
import { compareSearchPaths, normalizeSearchPath, sortSearchPaths, } from "../../domain/search/path-order.js";
import { collectGrepMatches, describeCompleteness, GLOB_LIMITS, GREP_LIMITS, LIST_DIR_LIMITS, takeInOrder, } from "../../domain/search/search-facts.js";
import { createRegexMatcher } from "./regex-matcher.js";
export const LIST_DIR_DEFINITION = {
    name: "list_dir",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
export const GLOB_DEFINITION = {
    name: "glob",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
export const GREP_DEFINITION = {
    name: "grep",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
const DEFINITIONS = [
    LIST_DIR_DEFINITION,
    GLOB_DEFINITION,
    GREP_DEFINITION,
];
export function createSearchTools(dependencies) {
    return {
        getDefinition(toolName) {
            return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
        },
        async execute(request) {
            dependencies.begin?.();
            if (request.toolName === LIST_DIR_DEFINITION.name) {
                return executeListDir(dependencies, request.arguments, request.signal);
            }
            if (request.toolName === GLOB_DEFINITION.name) {
                return executeGlob(dependencies, request.arguments, request.signal);
            }
            if (request.toolName === GREP_DEFINITION.name) {
                return executeGrep(dependencies, request.arguments, request.signal);
            }
            return { status: "failed", safeCode: "unknown_tool", text: null };
        },
    };
}
function failure(code) {
    return { status: "failed", safeCode: code, text: null };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnly(args, keys) {
    return Object.keys(args).every((key) => keys.includes(key));
}
function readOptionalPath(value) {
    if (value === undefined)
        return { ok: true, value: "" };
    if (typeof value !== "string")
        return { ok: false };
    if (hasControlCharacter(value))
        return { ok: false };
    return { ok: true, value: normalizeSearchPath(value) };
}
function hasControlCharacter(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f)
            return true;
    }
    return false;
}
function readInteger(value, minimum, maximum) {
    if (value === undefined)
        return { ok: false };
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        return { ok: false };
    }
    return { ok: true, value: value };
}
const COMPLETE = {
    scopeComplete: true,
    limitReached: false,
    ignoredPaths: [],
    skippedPaths: [],
    unsearchedPaths: [],
    ignoreRulesIncomplete: false,
};
async function executeListDir(dependencies, args, signal) {
    if (!isRecord(args))
        return failure("invalid_arguments");
    if (!hasOnly(args, ["path", "depth", "limit"]))
        return failure("invalid_arguments");
    const path = readOptionalPath(args["path"]);
    if (!path.ok)
        return failure("invalid_arguments");
    const depth = readInteger(args["depth"], 1, LIST_DIR_LIMITS.maxDepth);
    const depthValue = depth.ok ? depth.value : args["depth"] === undefined ? 1 : -1;
    if (depthValue < 0)
        return failure("invalid_arguments");
    const limit = readInteger(args["limit"], 1, LIST_DIR_LIMITS.maxEntries);
    const limitValue = limit.ok
        ? limit.value
        : args["limit"] === undefined
            ? LIST_DIR_LIMITS.defaultEntries
            : -1;
    if (limitValue < 0)
        return failure("invalid_arguments");
    const collected = [];
    const unsearched = [];
    try {
        await walk(path.value, depthValue, dependencies, collected, unsearched, signal);
    }
    catch {
        return failure("search_failed");
    }
    const ordered = [...collected].sort((left, right) => compareSearchPaths(left.path, right.path));
    const outcome = takeInOrder(ordered, limitValue);
    const completeness = {
        ...COMPLETE,
        scopeComplete: unsearched.length === 0 &&
            (dependencies.scopeFacts?.().skippedPaths.length ?? 0) === 0 &&
            !dependencies.scopeFacts?.().ignoreRulesIncomplete,
        limitReached: outcome.limitReached,
        ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
        ...dependencies.scopeFacts?.(),
        unsearchedPaths: [...unsearched, ...(dependencies.scopeFacts?.().unsearchedPaths ?? [])],
    };
    return {
        status: "succeeded",
        text: renderEntries(outcome.delivered, completeness, outcome.observedExtra),
    };
}
async function walk(directory, depth, dependencies, collected, unsearched, signal) {
    if (signal?.aborted) {
        unsearched.push(directory || ".");
        return;
    }
    const entries = await dependencies.listEntries(directory);
    for (const entry of entries) {
        if (isIgnored(dependencies, entry.path))
            continue;
        collected.push(entry);
        if (entry.kind === "directory" && !entry.isReparse && depth > 1) {
            try {
                await walk(entry.path, depth - 1, dependencies, collected, unsearched, signal);
            }
            catch {
                unsearched.push(entry.path);
            }
        }
    }
}
function isIgnored(dependencies, path) {
    const rules = dependencies.ignoreRules;
    if (rules === undefined || rules.length === 0)
        return false;
    return evaluateIgnoreWithAncestors(rules, path).ignored;
}
async function executeGlob(dependencies, args, signal) {
    if (!isRecord(args))
        return failure("invalid_arguments");
    if (!hasOnly(args, ["path", "pattern", "limit"]))
        return failure("invalid_arguments");
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.length === 0)
        return failure("invalid_arguments");
    const path = readOptionalPath(args["path"]);
    if (!path.ok)
        return failure("invalid_arguments");
    const limit = readInteger(args["limit"], 1, GLOB_LIMITS.maxPaths);
    const limitValue = limit.ok
        ? limit.value
        : args["limit"] === undefined
            ? GLOB_LIMITS.defaultPaths
            : -1;
    if (limitValue < 0)
        return failure("invalid_arguments");
    const regex = globToRegex(pattern);
    if (regex === null)
        return failure("invalid_arguments");
    const collected = [];
    const unsearched = [];
    try {
        await collectFiles(path.value, dependencies, collected, unsearched, signal);
    }
    catch {
        return failure("search_failed");
    }
    const matched = sortSearchPaths(collected.filter((candidate) => regex.test(candidate)));
    const outcome = takeInOrder(matched, limitValue);
    const completeness = {
        ...COMPLETE,
        scopeComplete: unsearched.length === 0 &&
            (dependencies.scopeFacts?.().skippedPaths.length ?? 0) === 0 &&
            !dependencies.scopeFacts?.().ignoreRulesIncomplete,
        limitReached: outcome.limitReached,
        ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
        ...dependencies.scopeFacts?.(),
        unsearchedPaths: [...unsearched, ...(dependencies.scopeFacts?.().unsearchedPaths ?? [])],
    };
    return {
        status: "succeeded",
        text: [
            `glob: ${outcome.delivered.length} path(s)`,
            describeCompleteness(completeness),
            ...(outcome.observedExtra > 0 ? [`observedExtra=${outcome.observedExtra}`] : []),
            ...outcome.delivered,
        ].join("\n"),
    };
}
async function collectFiles(directory, dependencies, collected, unsearched, signal) {
    if (signal?.aborted) {
        unsearched.push(directory || ".");
        return;
    }
    const entries = await dependencies.listEntries(directory);
    for (const entry of entries) {
        if (entry.isReparse) {
            unsearched.push(entry.path);
            continue;
        }
        if (isIgnored(dependencies, entry.path))
            continue;
        if (entry.kind === "file") {
            collected.push(entry.path);
            continue;
        }
        try {
            await collectFiles(entry.path, dependencies, collected, unsearched, signal);
        }
        catch {
            unsearched.push(entry.path);
        }
    }
}
async function executeGrep(dependencies, args, signal) {
    if (!isRecord(args))
        return failure("invalid_arguments");
    if (!hasOnly(args, [
        "path",
        "pattern",
        "limit",
        "regex",
        "caseSensitive",
        "contextBefore",
        "contextAfter",
    ]))
        return failure("invalid_arguments");
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.length === 0)
        return failure("invalid_arguments");
    if ((args["regex"] !== undefined && typeof args["regex"] !== "boolean") ||
        (args["caseSensitive"] !== undefined && typeof args["caseSensitive"] !== "boolean"))
        return failure("invalid_arguments");
    const regexMode = args["regex"] === true;
    const caseSensitive = args["caseSensitive"] !== false;
    const path = readOptionalPath(args["path"]);
    if (!path.ok)
        return failure("invalid_arguments");
    const limit = readInteger(args["limit"], 1, GREP_LIMITS.maxMatchLines);
    const limitValue = limit.ok
        ? limit.value
        : args["limit"] === undefined
            ? GREP_LIMITS.defaultMatchLines
            : -1;
    if (limitValue < 0)
        return failure("invalid_arguments");
    const before = readInteger(args["contextBefore"], 0, GREP_LIMITS.maxContextLines);
    const beforeValue = before.ok ? before.value : args["contextBefore"] === undefined ? 0 : -1;
    if (beforeValue < 0)
        return failure("invalid_arguments");
    const after = readInteger(args["contextAfter"], 0, GREP_LIMITS.maxContextLines);
    const afterValue = after.ok ? after.value : args["contextAfter"] === undefined ? 0 : -1;
    if (afterValue < 0)
        return failure("invalid_arguments");
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
    let regex = null;
    try {
        if (regexMode)
            regex = await createRegexMatcher(pattern, caseSensitive, signal, dependencies.regexTimeoutMs);
    }
    catch (error) {
        return failure(error instanceof Error ? error.message : "regex_worker_failed");
    }
    try {
        const files = [];
        const unsearched = [];
        try {
            await collectFiles(path.value, dependencies, files, unsearched, signal);
        }
        catch {
            return failure("search_failed");
        }
        const matches = [];
        const skipped = [];
        const orderedFiles = sortSearchPaths(files);
        let interrupted = null;
        for (const [position, file] of orderedFiles.entries()) {
            if (signal?.aborted) {
                interrupted = "search_cancelled";
                unsearched.push(...orderedFiles.slice(position));
                break;
            }
            let content;
            try {
                content = await dependencies.readText(file);
            }
            catch {
                skipped.push(file);
                continue;
            }
            const lines = content.split(/\r\n|\n|\r/);
            let indexes;
            try {
                indexes =
                    regex === null
                        ? lines.flatMap((line, index) => (matcher(line) ? [index] : []))
                        : await regex.match(lines);
            }
            catch (error) {
                interrupted = error instanceof Error ? error.message : "regex_worker_failed";
                unsearched.push(...orderedFiles.slice(position));
                break;
            }
            for (const index of indexes) {
                const line = lines[index] ?? "";
                matches.push({ path: file, lineNumber: index + 1, text: line });
            }
        }
        const result = collectGrepMatches(matches, {
            limit: limitValue,
            contextBefore: beforeValue,
            contextAfter: afterValue,
        });
        const completeness = {
            ...COMPLETE,
            scopeComplete: unsearched.length === 0 &&
                skipped.length === 0 &&
                (dependencies.scopeFacts?.().skippedPaths.length ?? 0) === 0 &&
                !dependencies.scopeFacts?.().ignoreRulesIncomplete,
            limitReached: result.limitReached,
            ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
            ...dependencies.scopeFacts?.(),
            unsearchedPaths: [...unsearched, ...(dependencies.scopeFacts?.().unsearchedPaths ?? [])],
            skippedPaths: [...skipped, ...(dependencies.scopeFacts?.().skippedPaths ?? [])],
        };
        const text = [
            `grep: ${result.hitLines} hit line(s)`,
            describeCompleteness(completeness),
            ...(interrupted === null ? [] : [`interrupted=${interrupted}`]),
            ...completeness.unsearchedPaths.map((file) => `unsearchedPath=${file}`),
            ...(result.observedExtra > 0 ? [`observedExtra=${result.observedExtra}`] : []),
            ...result.lines.map((line) => `${line.path}:${line.lineNumber}:${line.text}`),
        ].join("\n");
        return interrupted === null
            ? { status: "succeeded", text }
            : { status: "failed", safeCode: interrupted, text };
    }
    finally {
        await regex?.close();
    }
}
function globToRegex(pattern) {
    try {
        let output = "";
        for (let index = 0; index < pattern.length; index += 1) {
            const character = pattern[index] ?? "";
            if (character === "*") {
                if (pattern[index + 1] === "*") {
                    const following = pattern[index + 2];
                    output += following === "/" ? "(?:.*/)?" : ".*";
                    index += following === "/" ? 2 : 1;
                    continue;
                }
                output += "[^/]*";
                continue;
            }
            if (character === "?") {
                output += "[^/]";
                continue;
            }
            output += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        return new RegExp(`^${output}$`);
    }
    catch {
        return null;
    }
}
function renderEntries(entries, completeness, observedExtra) {
    return [
        `list_dir: ${entries.length} entr(y/ies)`,
        describeCompleteness(completeness),
        ...(observedExtra > 0 ? [`observedExtra=${observedExtra}`] : []),
        ...entries.map((entry) => `${entry.path}${entry.kind === "directory" ? "/" : ""}`),
    ].join("\n");
}
