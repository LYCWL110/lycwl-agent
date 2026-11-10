import { sortSearchPaths } from "../../domain/search/path-order.js";
export const COMPLETE_SCOPE = {
    scopeComplete: true,
    limitReached: false,
    ignoredPaths: [],
    skippedPaths: [],
    unsearchedPaths: [],
    ignoreRulesIncomplete: false,
};
export function hasIncompleteScope(completeness) {
    return (!completeness.scopeComplete ||
        completeness.skippedPaths.length > 0 ||
        completeness.unsearchedPaths.length > 0 ||
        completeness.ignoreRulesIncomplete);
}
export const LIST_DIR_LIMITS = Object.freeze({
    defaultEntries: 200,
    maxEntries: 1_000,
    maxDepth: 32,
});
export const GLOB_LIMITS = Object.freeze({ defaultPaths: 200, maxPaths: 1_000 });
export const GREP_LIMITS = Object.freeze({
    defaultMatchLines: 200,
    maxMatchLines: 1_000,
    maxContextLines: 10,
});
/**
 * Take the first N items in the already-deterministic order. `limitReached` is
 * reported only when an extra item was actually observed, never inferred from
 * `items.length === limit`.
 */
export function takeInOrder(items, limit) {
    const delivered = items.slice(0, limit);
    const extra = items.length - delivered.length;
    return {
        delivered,
        observedExtra: extra > 0 ? extra : 0,
        limitReached: extra > 0,
    };
}
/**
 * Count one hit per unique matching line, merge overlapping context windows, and
 * keep hit-line and context-line budgets separate.
 */
export function collectGrepMatches(matches, options) {
    const unique = new Map();
    for (const match of matches) {
        const key = `${match.path}\u0000${match.lineNumber}`;
        if (!unique.has(key))
            unique.set(key, match);
    }
    const ordered = [...unique.values()].sort((left, right) => {
        const byPath = sortSearchPaths([left.path, right.path]);
        if (byPath[0] !== byPath[1])
            return byPath[0] === left.path ? -1 : 1;
        return left.lineNumber - right.lineNumber;
    });
    const outcome = takeInOrder(ordered, options.limit);
    const byPath = new Map();
    for (const match of outcome.delivered) {
        const start = Math.max(1, match.lineNumber - options.contextBefore);
        const end = match.lineNumber + options.contextAfter;
        const ranges = byPath.get(match.path) ?? [];
        ranges.push({ start, end });
        byPath.set(match.path, ranges);
    }
    const mergedRanges = [];
    for (const [path, ranges] of byPath) {
        const sorted = [...ranges].sort((left, right) => left.start - right.start);
        for (const range of sorted) {
            const previous = mergedRanges.at(-1);
            if (previous !== undefined && previous.path === path && range.start <= previous.end + 1) {
                mergedRanges[mergedRanges.length - 1] = {
                    path,
                    start: previous.start,
                    end: Math.max(previous.end, range.end),
                };
                continue;
            }
            mergedRanges.push({ path, start: range.start, end: range.end });
        }
    }
    return {
        lines: outcome.delivered,
        hitLines: outcome.delivered.length,
        observedExtra: outcome.observedExtra,
        limitReached: outcome.limitReached,
        mergedRanges,
    };
}
export function describeCompleteness(completeness) {
    const parts = [];
    parts.push(completeness.scopeComplete ? "scope=complete" : "scope=partial");
    if (completeness.limitReached)
        parts.push("limit=reached");
    if (completeness.ignoredPaths.length > 0) {
        parts.push(`ignored=${completeness.ignoredPaths.length}`);
    }
    if (completeness.skippedPaths.length > 0) {
        parts.push(`skipped=${completeness.skippedPaths.length}`);
    }
    if (completeness.unsearchedPaths.length > 0) {
        parts.push(`unsearched=${completeness.unsearchedPaths.length}`);
    }
    if (completeness.ignoreRulesIncomplete)
        parts.push("ignoreRules=incomplete");
    return parts.join("; ");
}
