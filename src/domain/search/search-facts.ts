import { sortSearchPaths } from "../../domain/search/path-order.ts";

/**
 * Search completeness facts (ADR-0019/0020). "No match in the declared scope",
 * "hit the result limit", "skipped by permission/error" and "not searched" are
 * distinct facts; a single truncated boolean must not hide the difference.
 */
export type SearchCompleteness = Readonly<{
  /** True only when the declared scope was fully searched. */
  scopeComplete: boolean;
  /** True only when an extra match was actually observed beyond the limit. */
  limitReached: boolean;
  ignoredPaths: readonly string[];
  skippedPaths: readonly string[];
  unsearchedPaths: readonly string[];
  /** True when the ignore rules could not all be read/processed. */
  ignoreRulesIncomplete: boolean;
}>;

export const COMPLETE_SCOPE: SearchCompleteness = {
  scopeComplete: true,
  limitReached: false,
  ignoredPaths: [],
  skippedPaths: [],
  unsearchedPaths: [],
  ignoreRulesIncomplete: false,
};

export function hasIncompleteScope(completeness: SearchCompleteness): boolean {
  return (
    !completeness.scopeComplete ||
    completeness.skippedPaths.length > 0 ||
    completeness.unsearchedPaths.length > 0 ||
    completeness.ignoreRulesIncomplete
  );
}

export type SearchLimit = Readonly<{
  limit: number;
  max: number;
}>;

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

export type LimitOutcome<T> = Readonly<{
  delivered: readonly T[];
  /** Matches observed beyond the delivered set; only set when actually seen. */
  observedExtra: number;
  limitReached: boolean;
}>;

/**
 * Take the first N items in the already-deterministic order. `limitReached` is
 * reported only when an extra item was actually observed, never inferred from
 * `items.length === limit`.
 */
export function takeInOrder<T>(items: readonly T[], limit: number): LimitOutcome<T> {
  const delivered = items.slice(0, limit);
  const extra = items.length - delivered.length;
  return {
    delivered,
    observedExtra: extra > 0 ? extra : 0,
    limitReached: extra > 0,
  };
}

export type GrepMatchLine = Readonly<{
  path: string;
  lineNumber: number;
  text: string;
}>;

/**
 * Count one hit per unique matching line, merge overlapping context windows, and
 * keep hit-line and context-line budgets separate.
 */
export function collectGrepMatches(
  matches: readonly GrepMatchLine[],
  options: Readonly<{ limit: number; contextBefore: number; contextAfter: number }>,
): Readonly<{
  lines: readonly GrepMatchLine[];
  hitLines: number;
  observedExtra: number;
  limitReached: boolean;
  mergedRanges: readonly Readonly<{ path: string; start: number; end: number }>[];
}> {
  const unique = new Map<string, GrepMatchLine>();
  for (const match of matches) {
    const key = `${match.path}\u0000${match.lineNumber}`;
    if (!unique.has(key)) unique.set(key, match);
  }

  const ordered = [...unique.values()].sort((left, right) => {
    const byPath = sortSearchPaths([left.path, right.path]);
    if (byPath[0] !== byPath[1]) return byPath[0] === left.path ? -1 : 1;
    return left.lineNumber - right.lineNumber;
  });

  const outcome = takeInOrder(ordered, options.limit);
  const byPath = new Map<string, { start: number; end: number }[]>();
  for (const match of outcome.delivered) {
    const start = Math.max(1, match.lineNumber - options.contextBefore);
    const end = match.lineNumber + options.contextAfter;
    const ranges = byPath.get(match.path) ?? [];
    ranges.push({ start, end });
    byPath.set(match.path, ranges);
  }

  const mergedRanges: { path: string; start: number; end: number }[] = [];
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

export function describeCompleteness(completeness: SearchCompleteness): string {
  const parts: string[] = [];
  parts.push(completeness.scopeComplete ? "scope=complete" : "scope=partial");
  if (completeness.limitReached) parts.push("limit=reached");
  if (completeness.ignoredPaths.length > 0) {
    parts.push(`ignored=${completeness.ignoredPaths.length}`);
  }
  if (completeness.skippedPaths.length > 0) {
    parts.push(`skipped=${completeness.skippedPaths.length}`);
  }
  if (completeness.unsearchedPaths.length > 0) {
    parts.push(`unsearched=${completeness.unsearchedPaths.length}`);
  }
  if (completeness.ignoreRulesIncomplete) parts.push("ignoreRules=incomplete");
  return parts.join("; ");
}
