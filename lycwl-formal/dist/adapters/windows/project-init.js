import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { detectProjectFacts, INIT_LIMITS, renderAgentsDraft, } from "../../domain/context/project-init.js";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.js";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
/**
 * Generate an `AGENTS.md` draft for a project.
 *
 * The scan is shallow and bounded: a draft does not need a full repository walk, and
 * walking everything would be slow on a large tree. Directories that are obviously
 * generated or vendored are skipped, because listing `node_modules` would swamp the
 * extension counts.
 *
 * This module reads only; writing the draft is the caller's decision, so a user can
 * review it before any file exists.
 */
export const INIT_SKIP_DIRECTORIES = new Set([
    "node_modules",
    "dist",
    "build",
    "target",
    "out",
    "coverage",
    ".git",
    ".next",
    ".cache",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
]);
export function createProjectInit(options) {
    return {
        /** Scan the project and produce a draft without writing anything. */
        async scan() {
            const root = resolveWorkspacePath(options.workspaceRoot, options.workspaceRoot);
            if (!root.ok)
                return { ok: false, code: "invalid_workspace" };
            const absoluteRoot = root.value.absolutePath;
            // POSIX roots are case-sensitive: `Agents.md` is not the `AGENTS.md` this
            // module would write, and `Node_Modules` is not `node_modules`.
            const caseSensitive = isPosixWorkspaceRoot(absoluteRoot);
            const fold = (value) => (caseSensitive ? value : value.toLowerCase());
            let entries;
            try {
                entries = await scanShallow(absoluteRoot, fold);
            }
            catch (error) {
                return {
                    ok: false,
                    code: "scan_failed",
                    ...(error instanceof Error ? { detail: error.message } : {}),
                };
            }
            const facts = detectProjectFacts(entries, { caseSensitive });
            const agentManifest = caseSensitive ? "AGENTS.md" : "agents.md";
            const alreadyExists = entries.some((entry) => !entry.isDirectory && fold(entry.path) === agentManifest);
            const scriptOf = (name) => {
                const script = facts.scripts.find((entry) => entry.name === name);
                if (script === undefined)
                    return null;
                // A package manager prefix is required for a script to be runnable as written.
                return facts.packageManager === null
                    ? script.command
                    : `${facts.packageManager} run ${script.name}`;
            };
            const draft = renderAgentsDraft(facts, {
                projectName: facts.name,
                buildCommand: scriptOf("build"),
                testCommand: scriptOf("test"),
                lintCommand: scriptOf("lint"),
            });
            return { ok: true, facts, draft, alreadyExists };
        },
    };
}
/**
 * List the project up to a bounded depth.
 *
 * The manifest is read because scripts and the project name live in its contents; no
 * other file is read, so the scan cannot pull arbitrary project text into memory.
 */
async function scanShallow(absoluteRoot, fold) {
    const entries = [];
    async function walk(directory, relative, depth) {
        if (depth > INIT_LIMITS.maxDepth)
            return;
        let dirents;
        try {
            dirents = await readdir(directory, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const dirent of dirents) {
            const childRelative = relative.length === 0 ? dirent.name : `${relative}/${dirent.name}`;
            const childAbsolute = path.join(directory, dirent.name);
            if (dirent.isDirectory()) {
                if (INIT_SKIP_DIRECTORIES.has(fold(dirent.name)))
                    continue;
                entries.push({ path: childRelative, isDirectory: true });
                await walk(childAbsolute, childRelative, depth + 1);
                continue;
            }
            if (!dirent.isFile())
                continue;
            const entry = {
                path: childRelative,
                isDirectory: false,
            };
            if (fold(dirent.name) === "package.json") {
                try {
                    const text = await readFile(childAbsolute, "utf8");
                    // Bounded read: a manifest larger than this is not a manifest.
                    if (text.length <= 256 * 1024)
                        entry.content = text;
                }
                catch {
                    // An unreadable manifest simply contributes no scripts.
                }
            }
            entries.push(entry);
        }
    }
    await walk(absoluteRoot, "", 0);
    return entries;
}
