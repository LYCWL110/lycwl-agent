/**
 * Deterministic search path ordering (ADR-0020): normalize separators, compare
 * path segments by Unicode code point, ancestors before descendants. This is
 * not locale-aware sorting and does not replace Windows identity checks.
 */
export function normalizeSearchPath(value) {
    return value
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/|\/$/g, "");
}
export function splitSearchPath(value) {
    const normalized = normalizeSearchPath(value);
    return normalized.length === 0 ? [] : normalized.split("/");
}
function compareCodePoints(left, right) {
    const leftPoints = [...left];
    const rightPoints = [...right];
    const limit = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < limit; index += 1) {
        const a = leftPoints[index]?.codePointAt(0) ?? 0;
        const b = rightPoints[index]?.codePointAt(0) ?? 0;
        if (a !== b)
            return a < b ? -1 : 1;
    }
    if (leftPoints.length === rightPoints.length)
        return 0;
    return leftPoints.length < rightPoints.length ? -1 : 1;
}
export function compareSearchPaths(left, right) {
    const leftSegments = splitSearchPath(left);
    const rightSegments = splitSearchPath(right);
    const limit = Math.min(leftSegments.length, rightSegments.length);
    for (let index = 0; index < limit; index += 1) {
        const comparison = compareCodePoints(leftSegments[index] ?? "", rightSegments[index] ?? "");
        if (comparison !== 0)
            return comparison;
    }
    return leftSegments.length - rightSegments.length;
}
export function sortSearchPaths(paths) {
    return [...paths].sort(compareSearchPaths);
}
