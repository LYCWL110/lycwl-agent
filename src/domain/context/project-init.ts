/**
 * Project detection for `/init`.
 *
 * The goal is a useful `AGENTS.md` draft, not a complete project analysis. Every
 * value here is derived from files the caller has already listed, so this module is
 * pure: it cannot read the filesystem, and a test can exercise it with fixtures.
 *
 * What it deliberately does not do: invent conventions the project does not declare.
 * A missing test command produces no test section rather than a guessed `npm test`.
 */

export const INIT_LIMITS = Object.freeze({
  /** Directory depth inspected when inferring structure. */
  maxDepth: 3,
  /** Source directories listed in the draft. */
  maxSourceDirs: 8,
  /** File extensions listed in the draft. */
  maxExtensions: 8,
});

export type ProjectFacts = Readonly<{
  /** Package or project name, when declared. */
  name: string | null;
  /** Detected language family, most specific first. */
  languages: readonly string[];
  /** Package manager, when a lockfile or manifest implies one. */
  packageManager: string | null;
  /** Declared scripts, keyed by name, in declaration order. */
  scripts: readonly Readonly<{ name: string; command: string }>[];
  /** Top-level directories that contain source. */
  sourceDirs: readonly string[];
  /** Most common source extensions, most frequent first. */
  extensions: readonly string[];
  /** Notable configuration files present at the root. */
  configFiles: readonly string[];
}>;

export type FileEntry = Readonly<{
  /** Path relative to the project root, using `/`. */
  path: string;
  /** True for directories. */
  isDirectory: boolean;
  /**
   * Text content, present only for small manifests the caller chose to read.
   * Scripts and the project name cannot be inferred from a filename alone.
   */
  content?: string;
}>;

/**
 * Infer project facts from a flat listing.
 *
 * The listing is expected to be shallow (the caller bounds depth), because a full
 * repository walk is both slow and unnecessary for a draft.
 */
export function detectProjectFacts(files: readonly FileEntry[]): ProjectFacts {
  const paths = files.map((entry) => entry.path);
  const lower = new Map(paths.map((path) => [path.toLowerCase(), path]));

  const packageManager = detectPackageManager(lower);
  const extensions = detectExtensions(files);
  const languages = detectLanguages(lower, extensions);
  const scripts = detectScripts(files);
  const sourceDirs = detectSourceDirs(files);
  const configFiles = detectConfigFiles(lower);
  const name = detectName(lower, files);

  return { name, languages, packageManager, scripts, sourceDirs, extensions, configFiles };
}

function detectPackageManager(lower: ReadonlyMap<string, string>): string | null {
  if (lower.has("pnpm-lock.yaml")) return "pnpm";
  if (lower.has("yarn.lock")) return "yarn";
  if (lower.has("package-lock.json")) return "npm";
  if (lower.has("bun.lockb")) return "bun";
  if (lower.has("cargo.toml")) return "cargo";
  if (lower.has("pyproject.toml") || lower.has("requirements.txt")) return "pip";
  if (lower.has("go.mod")) return "go";
  return null;
}

function detectLanguages(
  lower: ReadonlyMap<string, string>,
  extensions: readonly string[],
): readonly string[] {
  const found: string[] = [];
  if (lower.has("tsconfig.json") || extensions.includes("ts")) found.push("TypeScript");
  else if (lower.has("package.json") || extensions.includes("js")) found.push("JavaScript");
  if (lower.has("cargo.toml") || extensions.includes("rs")) found.push("Rust");
  if (lower.has("pyproject.toml") || lower.has("requirements.txt") || extensions.includes("py")) {
    found.push("Python");
  }
  if (lower.has("go.mod") || extensions.includes("go")) found.push("Go");
  if (lower.has("pom.xml") || lower.has("build.gradle") || lower.has("build.gradle.kts")) {
    found.push("Java");
  }
  return found;
}

/**
 * Read declared scripts from a `package.json`-shaped listing.
 *
 * The listing carries file contents only for the manifest, because parsing scripts
 * from a name alone is impossible. An absent or unparsable manifest yields none.
 */
function detectScripts(files: readonly FileEntry[]): readonly { name: string; command: string }[] {
  const manifest = files.find(
    (entry) => !entry.isDirectory && entry.path.toLowerCase() === "package.json",
  );
  if (manifest?.content === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(manifest.content);
    if (typeof parsed !== "object" || parsed === null) return [];
    const scripts = (parsed as Record<string, unknown>)["scripts"];
    if (typeof scripts !== "object" || scripts === null) return [];
    const result: { name: string; command: string }[] = [];
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command !== "string" || command.length === 0) continue;
      result.push({ name, command });
    }
    return result;
  } catch {
    // A malformed manifest yields no scripts rather than a guessed set.
    return [];
  }
}

function detectSourceDirs(files: readonly FileEntry[]): readonly string[] {
  const candidates = new Set<string>();
  for (const entry of files) {
    if (!entry.isDirectory) continue;
    const segments = entry.path.split("/");
    if (segments.length !== 1) continue;
    const name = segments[0] ?? "";
    if (isSourceDirName(name)) candidates.add(name);
  }
  return [...candidates]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, INIT_LIMITS.maxSourceDirs);
}

const SOURCE_DIR_NAMES: ReadonlySet<string> = new Set([
  "src",
  "lib",
  "app",
  "packages",
  "crates",
  "cmd",
  "internal",
  "pkg",
  "test",
  "tests",
  "spec",
  "docs",
]);

function isSourceDirName(name: string): boolean {
  return SOURCE_DIR_NAMES.has(name.toLowerCase());
}

function detectExtensions(files: readonly FileEntry[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const entry of files) {
    if (entry.isDirectory) continue;
    const match = /\.([A-Za-z0-9]+)$/u.exec(entry.path);
    const extension = match?.[1]?.toLowerCase();
    if (extension === undefined) continue;
    if (!isSourceExtension(extension)) continue;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (left[1] !== right[1]) return right[1] - left[1];
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .slice(0, INIT_LIMITS.maxExtensions)
    .map(([extension]) => extension);
}

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "py",
  "go",
  "java",
  "kt",
  "cs",
  "cpp",
  "c",
  "h",
  "rb",
  "php",
  "swift",
]);

function isSourceExtension(extension: string): boolean {
  return SOURCE_EXTENSIONS.has(extension);
}

function detectConfigFiles(lower: ReadonlyMap<string, string>): readonly string[] {
  const notable = [
    "tsconfig.json",
    "biome.json",
    ".eslintrc.json",
    "eslint.config.js",
    "vitest.config.ts",
    "jest.config.js",
    "cargo.toml",
    "pyproject.toml",
    "go.mod",
    ".editorconfig",
    ".gitattributes",
  ];
  const found: string[] = [];
  for (const name of notable) {
    const actual = lower.get(name);
    if (actual !== undefined) found.push(actual);
  }
  return found;
}

function detectName(
  lower: ReadonlyMap<string, string>,
  files: readonly FileEntry[],
): string | null {
  void lower;
  const manifest = files.find(
    (entry) => !entry.isDirectory && entry.path.toLowerCase() === "package.json",
  );
  if (manifest?.content === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(manifest.content);
    if (typeof parsed !== "object" || parsed === null) return null;
    const name = (parsed as Record<string, unknown>)["name"];
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Render the draft.
 *
 * Only facts that were actually detected appear. An empty section would suggest the
 * project has no conventions, which is a claim this cannot make.
 */
export function renderAgentsDraft(
  facts: ProjectFacts,
  options: {
    projectName: string | null;
    testCommand: string | null;
    buildCommand: string | null;
    lintCommand: string | null;
  },
): string {
  const lines: string[] = [];
  const title = options.projectName ?? facts.name;
  lines.push(title === null ? "# Project Guide" : `# ${title}`);
  lines.push("");

  if (facts.languages.length > 0) {
    lines.push("## Stack");
    lines.push("");
    lines.push(`- Languages: ${facts.languages.join(", ")}`);
    if (facts.packageManager !== null) lines.push(`- Package manager: ${facts.packageManager}`);
    if (facts.extensions.length > 0) {
      lines.push(`- Source extensions: ${facts.extensions.map((ext) => `.${ext}`).join(", ")}`);
    }
    lines.push("");
  }

  if (facts.sourceDirs.length > 0) {
    lines.push("## Layout");
    lines.push("");
    for (const directory of facts.sourceDirs) lines.push(`- \`${directory}/\``);
    lines.push("");
  }

  const commands: string[] = [];
  if (options.buildCommand !== null) commands.push(`- Build: \`${options.buildCommand}\``);
  if (options.testCommand !== null) commands.push(`- Test: \`${options.testCommand}\``);
  if (options.lintCommand !== null) commands.push(`- Lint: \`${options.lintCommand}\``);
  if (commands.length > 0) {
    lines.push("## Commands");
    lines.push("");
    lines.push(...commands);
    lines.push("");
  }

  if (facts.configFiles.length > 0) {
    lines.push("## Configuration");
    lines.push("");
    for (const file of facts.configFiles) lines.push(`- \`${file}\``);
    lines.push("");
  }

  lines.push("## Conventions");
  lines.push("");
  lines.push("<!-- Describe the rules this project follows. Be specific: vague guidance is");
  lines.push("     not actionable, and this file cannot change permissions or tool policy. -->");
  lines.push("");
  lines.push("- Prefer small, focused changes.");
  lines.push("- Run the tests above before reporting work as complete.");
  lines.push("");
  return lines.join("\n");
}
