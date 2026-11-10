/**
 * Formatter selection.
 *
 * A project's own configuration decides whether a formatter runs, not this
 * Harness: a repository that has no `biome.json` does not want Biome applied to it,
 * and running one anyway would produce a diff the user never asked for.
 *
 * Discovery is a read of project files, which grants nothing. Execution is a
 * separate step that goes through the ordinary approval path, because a formatter
 * is an external program that rewrites files.
 *
 * The formatter list is deliberately short. Each entry needs a config-file signal
 * that is unambiguous and a command whose behavior is "format this file in place";
 * a longer list would mean guessing about projects this Harness has not seen.
 */
export const FORMATTERS = Object.freeze([
    {
        kind: "biome",
        // Biome's config is unambiguous: a project that has one wants Biome.
        configFiles: ["biome.json", "biome.jsonc"],
        packageName: "@biomejs/biome",
        extensions: [
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".json",
            ".jsonc",
            ".css",
            ".graphql",
        ],
        args: ["format", "--write", "$FILE"],
    },
    {
        kind: "prettier",
        // Prettier has no single config file. The signal is a `prettier` entry in
        // package.json or one of its config files; both are checked.
        configFiles: [
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
        ],
        packageName: "prettier",
        extensions: [
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".html",
            ".htm",
            ".css",
            ".scss",
            ".less",
            ".vue",
            ".svelte",
            ".json",
            ".jsonc",
            ".yaml",
            ".yml",
            ".md",
            ".mdx",
            ".graphql",
        ],
        args: ["--write", "$FILE"],
    },
]);
/**
 * Choose the formatter for a path, given the files present in the workspace.
 *
 * `presentFiles` is the set of config files found at the workspace root. Prettier
 * also needs a `package.json` that declares it, which the caller checks separately
 * because it requires reading and parsing that file.
 */
export function selectFormatter(input) {
    const extension = extensionOf(input.path);
    if (extension === null)
        return { ok: false, code: "invalid_path" };
    for (const formatter of FORMATTERS) {
        if (!formatter.extensions.includes(extension))
            continue;
        const hasConfig = formatter.configFiles.some((file) => input.presentConfigFiles.includes(file));
        // A formatter needs either its own config file or a declared dependency. A
        // dependency alone is not enough for Biome, whose config is what selects it;
        // for Prettier the dependency is the signal.
        const configured = formatter.kind === "biome" ? hasConfig : hasConfig || input.declares(formatter.packageName);
        if (configured)
            return { ok: true, formatter };
    }
    // Distinguish "this project has no formatter" from "this file type is not one a
    // formatter would touch", because the two call for different responses.
    const anyExtension = FORMATTERS.some((formatter) => formatter.extensions.includes(extension));
    return { ok: false, code: anyExtension ? "no_configuration" : "unsupported_extension" };
}
/** Lowercase extension including the dot, or null for a path with none. */
export function extensionOf(filePath) {
    const name = filePath.replace(/\\/gu, "/").split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1)
        return null;
    return name.slice(dot).toLowerCase();
}
/** The command line for one file, with the executable resolved by the caller. */
export function formatterCommand(formatter, executable, filePath) {
    return [executable, ...formatter.args.map((arg) => arg.replace("$FILE", filePath))];
}
/**
 * Whether a path is one the Harness should format.
 *
 * Generated and vendored trees are excluded: formatting `node_modules` or a build
 * output would rewrite files the project does not own, and a formatter run on a
 * large tree is a long uninterruptible operation.
 */
export function isFormattablePath(filePath) {
    const normalized = filePath.replace(/\\/gu, "/");
    if (normalized.startsWith("/"))
        return false;
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
        return false;
    }
    const excluded = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        "out",
        "coverage",
        ".next",
        ".nuxt",
        "target",
        "vendor",
    ]);
    return !segments.some((segment) => excluded.has(segment));
}
