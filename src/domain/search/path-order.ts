/**
 * Deterministic search path ordering (ADR-0020): normalize separators, compare
 * path segments by Unicode code point, ancestors before descendants. This is
 * not locale-aware sorting and does not replace Windows identity checks.
 */
export function normalizeSearchPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function splitSearchPath(value: string): readonly string[] {
  const normalized = normalizeSearchPath(value);
  return normalized.length === 0 ? [] : normalized.split("/");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1) {
    const a = leftPoints[index]?.codePointAt(0) ?? 0;
    const b = rightPoints[index]?.codePointAt(0) ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

export function compareSearchPaths(left: string, right: string): number {
  const leftSegments = splitSearchPath(left);
  const rightSegments = splitSearchPath(right);
  const limit = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < limit; index += 1) {
    const comparison = compareCodePoints(leftSegments[index] ?? "", rightSegments[index] ?? "");
    if (comparison !== 0) return comparison;
  }
  return leftSegments.length - rightSegments.length;
}

export function sortSearchPaths<T extends string>(paths: readonly T[]): T[] {
  return [...paths].sort(compareSearchPaths);
}
