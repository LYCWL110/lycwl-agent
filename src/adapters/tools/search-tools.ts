import { evaluateIgnoreWithAncestors, type IgnoreRule } from "../../domain/search/ignore-rules.ts";
import {
  compareSearchPaths,
  normalizeSearchPath,
  sortSearchPaths,
} from "../../domain/search/path-order.ts";
import {
  collectGrepMatches,
  describeCompleteness,
  GLOB_LIMITS,
  GREP_LIMITS,
  LIST_DIR_LIMITS,
  type SearchCompleteness,
  takeInOrder,
} from "../../domain/search/search-facts.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

/**
 * Injected workspace listing for the read-only search tools. `listEntries`
 * returns already-authorized entries; this module never reads file content or
 * bypasses the permission policy. A real Windows adapter is Stage 2 work.
 */
export type SearchEntry = Readonly<{
  path: string;
  kind: "file" | "directory";
}>;

export type SearchToolDependencies = Readonly<{
  /** Lists direct children of a workspace-relative directory. */
  listEntries: (directory: string) => Promise<readonly SearchEntry[]>;
  /** Reads a text file already cleared by the read policy. */
  readText: (path: string) => Promise<string>;
  /** Workspace ignore rules already parsed from `.ignore`/`.gitignore`. */
  ignoreRules?: readonly IgnoreRule[];
  /** True when some ignore rules could not be read or processed. */
  ignoreRulesIncomplete?: boolean;
}>;

export const LIST_DIR_DEFINITION: ToolDefinition = {
  name: "list_dir",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export const GLOB_DEFINITION: ToolDefinition = {
  name: "glob",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export const GREP_DEFINITION: ToolDefinition = {
  name: "grep",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

const DEFINITIONS: readonly ToolDefinition[] = [
  LIST_DIR_DEFINITION,
  GLOB_DEFINITION,
  GREP_DEFINITION,
];

export function createSearchTools(dependencies: SearchToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      if (request.toolName === LIST_DIR_DEFINITION.name) {
        return executeListDir(dependencies, request.arguments);
      }
      if (request.toolName === GLOB_DEFINITION.name) {
        return executeGlob(dependencies, request.arguments);
      }
      if (request.toolName === GREP_DEFINITION.name) {
        return executeGrep(dependencies, request.arguments);
      }
      return { status: "failed", safeCode: "unknown_tool", text: null };
    },
  };
}

function failure(code: string): ToolExecutionResult {
  return { status: "failed", safeCode: code, text: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalPath(value: unknown): { ok: true; value: string } | { ok: false } {
  if (value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false };
  if (hasControlCharacter(value)) return { ok: false };
  return { ok: true, value: normalizeSearchPath(value) };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function readInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): { ok: true; value: number } | { ok: false } {
  if (value === undefined) return { ok: false };
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return { ok: false };
  }
  return { ok: true, value: value as number };
}

const COMPLETE: SearchCompleteness = {
  scopeComplete: true,
  limitReached: false,
  ignoredPaths: [],
  skippedPaths: [],
  unsearchedPaths: [],
  ignoreRulesIncomplete: false,
};

async function executeListDir(
  dependencies: SearchToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  if (!isRecord(args)) return failure("invalid_arguments");
  const path = readOptionalPath(args["path"]);
  if (!path.ok) return failure("invalid_arguments");
  const depth = readInteger(args["depth"], 0, LIST_DIR_LIMITS.maxDepth);
  const depthValue = depth.ok ? depth.value : args["depth"] === undefined ? 1 : -1;
  if (depthValue < 0) return failure("invalid_arguments");
  const limit = readInteger(args["limit"], 1, LIST_DIR_LIMITS.maxEntries);
  const limitValue = limit.ok
    ? limit.value
    : args["limit"] === undefined
      ? LIST_DIR_LIMITS.defaultEntries
      : -1;
  if (limitValue < 0) return failure("invalid_arguments");

  const collected: SearchEntry[] = [];
  const unsearched: string[] = [];
  try {
    await walk(path.value, depthValue, dependencies, collected, unsearched);
  } catch {
    return failure("search_failed");
  }

  const ordered = [...collected].sort((left, right) => compareSearchPaths(left.path, right.path));
  const outcome = takeInOrder(ordered, limitValue);
  const completeness: SearchCompleteness = {
    ...COMPLETE,
    scopeComplete: unsearched.length === 0,
    limitReached: outcome.limitReached,
    unsearchedPaths: unsearched,
    ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
  };
  return {
    status: "succeeded",
    text: renderEntries(outcome.delivered, completeness, outcome.observedExtra),
  };
}

async function walk(
  directory: string,
  depth: number,
  dependencies: SearchToolDependencies,
  collected: SearchEntry[],
  unsearched: string[],
): Promise<void> {
  const entries = await dependencies.listEntries(directory);
  for (const entry of entries) {
    if (isIgnored(dependencies, entry.path)) continue;
    collected.push(entry);
    if (entry.kind === "directory" && depth > 1) {
      try {
        await walk(entry.path, depth - 1, dependencies, collected, unsearched);
      } catch {
        unsearched.push(entry.path);
      }
    }
  }
}

function isIgnored(dependencies: SearchToolDependencies, path: string): boolean {
  const rules = dependencies.ignoreRules;
  if (rules === undefined || rules.length === 0) return false;
  return evaluateIgnoreWithAncestors(rules, path).ignored;
}

async function executeGlob(
  dependencies: SearchToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  if (!isRecord(args)) return failure("invalid_arguments");
  const pattern = args["pattern"];
  if (typeof pattern !== "string" || pattern.length === 0) return failure("invalid_arguments");
  const path = readOptionalPath(args["path"]);
  if (!path.ok) return failure("invalid_arguments");
  const limit = readInteger(args["limit"], 1, GLOB_LIMITS.maxPaths);
  const limitValue = limit.ok
    ? limit.value
    : args["limit"] === undefined
      ? GLOB_LIMITS.defaultPaths
      : -1;
  if (limitValue < 0) return failure("invalid_arguments");

  const regex = globToRegex(pattern);
  if (regex === null) return failure("invalid_arguments");

  const collected: string[] = [];
  const unsearched: string[] = [];
  try {
    await collectFiles(path.value, dependencies, collected, unsearched);
  } catch {
    return failure("search_failed");
  }

  const matched = sortSearchPaths(collected.filter((candidate) => regex.test(candidate)));
  const outcome = takeInOrder(matched, limitValue);
  const completeness: SearchCompleteness = {
    ...COMPLETE,
    scopeComplete: unsearched.length === 0,
    limitReached: outcome.limitReached,
    unsearchedPaths: unsearched,
    ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
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

async function collectFiles(
  directory: string,
  dependencies: SearchToolDependencies,
  collected: string[],
  unsearched: string[],
): Promise<void> {
  const entries = await dependencies.listEntries(directory);
  for (const entry of entries) {
    if (isIgnored(dependencies, entry.path)) continue;
    if (entry.kind === "file") {
      collected.push(entry.path);
      continue;
    }
    try {
      await collectFiles(entry.path, dependencies, collected, unsearched);
    } catch {
      unsearched.push(entry.path);
    }
  }
}

async function executeGrep(
  dependencies: SearchToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  if (!isRecord(args)) return failure("invalid_arguments");
  const pattern = args["pattern"];
  if (typeof pattern !== "string" || pattern.length === 0) return failure("invalid_arguments");
  const regexMode = args["regex"] === true;
  const caseSensitive = args["caseSensitive"] !== false;
  const path = readOptionalPath(args["path"]);
  if (!path.ok) return failure("invalid_arguments");
  const limit = readInteger(args["limit"], 1, GREP_LIMITS.maxMatchLines);
  const limitValue = limit.ok
    ? limit.value
    : args["limit"] === undefined
      ? GREP_LIMITS.defaultMatchLines
      : -1;
  if (limitValue < 0) return failure("invalid_arguments");
  const before = readInteger(args["contextBefore"], 0, GREP_LIMITS.maxContextLines);
  const beforeValue = before.ok ? before.value : args["contextBefore"] === undefined ? 0 : -1;
  if (beforeValue < 0) return failure("invalid_arguments");
  const after = readInteger(args["contextAfter"], 0, GREP_LIMITS.maxContextLines);
  const afterValue = after.ok ? after.value : args["contextAfter"] === undefined ? 0 : -1;
  if (afterValue < 0) return failure("invalid_arguments");

  const matcher = buildMatcher(pattern, regexMode, caseSensitive);
  if (matcher === null) return failure("invalid_pattern");

  const files: string[] = [];
  const unsearched: string[] = [];
  try {
    await collectFiles(path.value, dependencies, files, unsearched);
  } catch {
    return failure("search_failed");
  }

  const matches: { path: string; lineNumber: number; text: string }[] = [];
  const skipped: string[] = [];
  for (const file of sortSearchPaths(files)) {
    let content: string;
    try {
      content = await dependencies.readText(file);
    } catch {
      skipped.push(file);
      continue;
    }
    const lines = content.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (matcher(line)) matches.push({ path: file, lineNumber: index + 1, text: line });
    }
  }

  const result = collectGrepMatches(matches, {
    limit: limitValue,
    contextBefore: beforeValue,
    contextAfter: afterValue,
  });
  const completeness: SearchCompleteness = {
    ...COMPLETE,
    scopeComplete: unsearched.length === 0 && skipped.length === 0,
    limitReached: result.limitReached,
    skippedPaths: skipped,
    unsearchedPaths: unsearched,
    ignoreRulesIncomplete: dependencies.ignoreRulesIncomplete === true,
  };

  return {
    status: "succeeded",
    text: [
      `grep: ${result.hitLines} hit line(s)`,
      describeCompleteness(completeness),
      ...(result.observedExtra > 0 ? [`observedExtra=${result.observedExtra}`] : []),
      ...result.lines.map((line) => `${line.path}:${line.lineNumber}:${line.text}`),
    ].join("\n"),
  };
}

function buildMatcher(
  pattern: string,
  regexMode: boolean,
  caseSensitive: boolean,
): ((line: string) => boolean) | null {
  if (regexMode) {
    try {
      const expression = new RegExp(pattern, caseSensitive ? "u" : "iu");
      return (line) => expression.test(line);
    } catch {
      return null;
    }
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

function globToRegex(pattern: string): RegExp | null {
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
  } catch {
    return null;
  }
}

function renderEntries(
  entries: readonly SearchEntry[],
  completeness: SearchCompleteness,
  observedExtra: number,
): string {
  return [
    `list_dir: ${entries.length} entr(y/ies)`,
    describeCompleteness(completeness),
    ...(observedExtra > 0 ? [`observedExtra=${observedExtra}`] : []),
    ...entries.map((entry) => `${entry.path}${entry.kind === "directory" ? "/" : ""}`),
  ].join("\n");
}
