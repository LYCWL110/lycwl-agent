/**
 * Extract candidate paths a tool invocation touches.
 *
 * Project guidance applies to a directory subtree. When the model reads or writes
 * `src/api/handler.ts`, the `AGENTS.md` in `src/api/` becomes relevant and the one
 * at the workspace root may no longer be enough.
 *
 * This is deliberately a small, explicit mapping rather than a generic "find any
 * string that looks like a path": a false positive would load guidance from an
 * unrelated directory, and a false negative would silently miss a rule. Only
 * parameters whose meaning is known are inspected.
 *
 * The result is a list of *claimed* paths. Nothing here checks that they exist or
 * are inside the workspace; the loader does that through the normal path policy.
 */

export type TouchedPath = Readonly<{
  /** The path as supplied by the tool call. */
  path: string;
  /** True when the call treats it as a directory. */
  isDirectory: boolean;
}>;

/**
 * Parameters that carry a path, by tool name.
 *
 * `null` means "ignore this tool". A tool absent from the map is also ignored: an
 * unknown tool cannot be assumed to touch the filesystem.
 */
const PATH_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read_file: ["path"],
  create_file: ["path"],
  edit_file: ["path"],
  list_dir: ["path"],
  glob: ["path"],
  grep: ["path"],
  delete_path: ["path"],
  rename_path: ["from", "to"],
  lsp_diagnostics: ["path"],
  lsp_definition: ["path"],
  lsp_references: ["path"],
  background_start: ["cwd"],
});

/** Tools whose path parameter denotes a directory rather than a file. */
const DIRECTORY_TOOLS: ReadonlySet<string> = new Set([
  "list_dir",
  "glob",
  "grep",
  "background_start",
]);

export function touchedPaths(toolName: string, args: unknown): readonly TouchedPath[] {
  const parameters = PATH_PARAMETERS[toolName];
  if (parameters === undefined) return [];
  if (typeof args !== "object" || args === null) return [];

  const record = args as Record<string, unknown>;
  const paths: TouchedPath[] = [];
  for (const parameter of parameters) {
    const value = record[parameter];
    if (typeof value !== "string" || value.length === 0) continue;
    // An empty or root-relative path means "the workspace root", which is already
    // covered by the launch-time guidance.
    const isDirectory = DIRECTORY_TOOLS.has(toolName) && parameter !== "to";
    paths.push({ path: value, isDirectory });
  }
  return paths;
}

/**
 * Union two sets of touched paths, keeping the first occurrence of each so the
 * order stays deterministic.
 */
export function mergeTouchedPaths(
  existing: readonly TouchedPath[],
  added: readonly TouchedPath[],
): readonly TouchedPath[] {
  const seen = new Set(existing.map((entry) => `${entry.isDirectory ? "d" : "f"}:${entry.path}`));
  const merged = [...existing];
  for (const entry of added) {
    const key = `${entry.isDirectory ? "d" : "f"}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
