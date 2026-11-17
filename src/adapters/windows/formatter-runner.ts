import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  type FormatterDefinition,
  formatterCommand,
  isFormattablePath,
  selectFormatter,
} from "../../domain/format/formatter.ts";
import { filterChildEnvironment } from "../../domain/process/shell.ts";
import type { FormatResult, FormatterRunner } from "../../ports/formatter.ts";

/**
 * Run a project's formatter on one file.
 *
 * Two properties are non-negotiable here:
 *
 * - **Nothing is guessed.** A formatter runs only when the project's own
 *   configuration selects it and the executable is installed. Running a formatter a
 *   project did not ask for would rewrite files the user never offered.
 * - **The environment is filtered.** `execFile` inherits the parent environment, so
 *   the same C09 filter used for every other child process is applied first; a
 *   formatter has no business seeing a Provider key.
 *
 * A formatter that exits non-zero is reported, not retried: the file may be in a
 * partially formatted state, and re-running would not tell the user anything new.
 */

const run = promisify(execFile);

export const FORMATTER_TIMEOUT_MS = 30_000;

export type FormatterRunnerOptions = Readonly<{
  workspaceRoot: string;
  /** The already-filtered environment for the child process. */
  environment: Readonly<Record<string, string>>;
  /** Injected for tests. */
  execute?: (
    command: string,
    args: readonly string[],
    options: Readonly<{ cwd: string; env: Record<string, string>; timeout: number }>,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Resolve a package's executable; defaults to a workspace-local lookup. */
  resolveExecutable?: (packageName: string) => Promise<string | null>;
}>;

export function createFormatterRunner(options: FormatterRunnerOptions): FormatterRunner {
  const execute =
    options.execute ??
    (async (command, args, execOptions) => {
      const result = await run(command, [...args], {
        cwd: execOptions.cwd,
        env: execOptions.env,
        timeout: execOptions.timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  const resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;

  async function detect(): Promise<FormatterDefinition | null> {
    const present = await presentConfigFiles(options.workspaceRoot);
    const declares = await declaredPackages(options.workspaceRoot);
    // The path only matters for its extension here; any supported extension will do
    // to ask "which formatter does this project use".
    const probe = selectFormatter({
      path: "probe.ts",
      presentConfigFiles: present,
      declares: (name) => declares.has(name),
    });
    return probe.ok ? probe.formatter : null;
  }

  return {
    detect,

    async format(input) {
      if (!isFormattablePath(input.relativePath)) {
        return { ok: false, code: "excluded_path" };
      }
      const present = await presentConfigFiles(options.workspaceRoot);
      const declares = await declaredPackages(options.workspaceRoot);
      const selected = selectFormatter({
        path: input.relativePath,
        presentConfigFiles: present,
        declares: (name) => declares.has(name),
      });
      if (!selected.ok) return { ok: false, code: selected.code };

      const executable = await resolveExecutable(selected.formatter.packageName);
      if (executable === null) return { ok: false, code: "not_installed" };

      const [command, ...args] = formatterCommand(
        selected.formatter,
        executable,
        input.resolvedPath,
      );
      if (command === undefined) return { ok: false, code: "not_installed" };

      try {
        // Filter here as well as at the call site. The composition root already
        // passes a filtered environment, but a second pass makes this adapter safe
        // to call with any environment, which is what a reusable boundary needs.
        await execute(command, args, {
          cwd: options.workspaceRoot,
          env: filterChildEnvironment(
            options.environment,
            {},
            { platform: process.platform === "linux" ? "linux" : "win32" },
          ).environment as Record<string, string>,
          timeout: FORMATTER_TIMEOUT_MS,
        });
        return { ok: true, formatter: selected.formatter.kind };
      } catch (error) {
        // A timeout is distinguished from a formatter that ran and objected: the
        // first may have left the file half-written, the second did not.
        if (isTimeout(error)) return { ok: false, code: "timeout" };
        return {
          ok: false,
          code: "format_failed",
          ...(error instanceof Error ? { detail: error.message.slice(0, 200) } : {}),
        };
      }
    },
  };
}

/** Config files present at the workspace root, as bare names. */
async function presentConfigFiles(root: string): Promise<readonly string[]> {
  const candidates = [
    "biome.json",
    "biome.jsonc",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.json5",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
  ];
  const present: string[] = [];
  for (const name of candidates) {
    try {
      const info = await stat(path.join(root, name));
      if (info.isFile()) present.push(name);
    } catch {
      // Absent is the normal case for most of these.
    }
  }
  return present;
}

/** Package names declared in package.json dependencies or devDependencies. */
async function declaredPackages(root: string): Promise<ReadonlySet<string>> {
  try {
    const text = await readFile(path.join(root, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return new Set();
    const record = parsed as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies"]) {
      const block = record[field];
      if (typeof block !== "object" || block === null) continue;
      for (const name of Object.keys(block)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Resolve a formatter executable from the workspace's own `node_modules`.
 *
 * A globally installed formatter is deliberately not used: the project declared its
 * formatter as a dependency, and running a different version than the project
 * pinned would reformat files to a style the project did not choose.
 */
async function defaultResolveExecutable(packageName: string): Promise<string | null> {
  const binary = packageName === "@biomejs/biome" ? "biome" : packageName;
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(process.cwd(), "node_modules", ".bin", `${binary}${suffix}`);
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("killed" in error || ("code" in error && error.code === "ETIMEDOUT"))
  );
}
