import { discoverProjectGuidance, } from "../../domain/context/project-guidance.js";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
import { createWindowsFileReader } from "./windows-directory-reader.js";
export function createProjectGuidanceDiscovery(options) {
    const reader = createWindowsFileReader({ workspaceRoot: options.workspaceRoot });
    return {
        async discover(input) {
            // Resolve the path set first. If the target is malformed or outside the
            // workspace, discovery fails before listing anything.
            const directories = directoriesOnPath(options.workspaceRoot, input.targetPath, input.targetIsDirectory);
            if (directories === null) {
                return { ok: false, code: "target_outside_workspace" };
            }
            const listings = new Map();
            for (const directory of directories) {
                const resolved = resolveWorkspacePath(options.workspaceRoot, directory);
                if (!resolved.ok)
                    return { ok: false, code: "invalid_target_path" };
                const listed = await reader.listDirectory(resolved.value.absolutePath);
                // A directory that cannot be listed contributes no candidate: discovery
                // must not fail just because an intermediate directory is inaccessible.
                if (!listed.ok)
                    continue;
                listings.set(directory, listed.entries.map((entry) => entry.path.replace(/\\/g, "/").split("/").at(-1) ?? ""));
            }
            const discovered = discoverProjectGuidance({
                workspaceRoot: options.workspaceRoot,
                targetPath: input.targetPath,
                targetIsDirectory: input.targetIsDirectory,
                entriesFor: (directory) => listings.get(directory) ?? [],
            });
            if (!discovered.ok)
                return { ok: false, code: discovered.code };
            return { ok: true, candidates: discovered.candidates };
        },
    };
}
/**
 * Directories from the workspace root down to the target's own directory, in
 * application order. Returns null when the target escapes the workspace.
 */
function directoriesOnPath(workspaceRoot, targetPath, targetIsDirectory) {
    const resolvedRoot = resolveWorkspacePath(workspaceRoot, workspaceRoot);
    if (!resolvedRoot.ok)
        return null;
    const root = resolvedRoot.value.absolutePath.replace(/\\+$/, "");
    const resolvedTarget = resolveWorkspacePath(workspaceRoot, targetPath);
    if (!resolvedTarget.ok)
        return null;
    if (!resolvedTarget.value.withinWorkspace)
        return null;
    const target = resolvedTarget.value.absolutePath.replace(/\\+$/, "");
    const directory = targetIsDirectory ? target : parentOf(target);
    const lowerRoot = root.toLowerCase();
    const lowerDirectory = directory.toLowerCase();
    if (lowerDirectory !== lowerRoot && !lowerDirectory.startsWith(`${lowerRoot}\\`)) {
        return null;
    }
    const relative = directory.slice(root.length).replace(/^\\+/, "");
    const segments = relative.length === 0 ? [] : relative.split("\\");
    const directories = [root];
    for (let depth = 1; depth <= segments.length; depth += 1) {
        directories.push(`${root}\\${segments.slice(0, depth).join("\\")}`);
    }
    return directories;
}
function parentOf(value) {
    const index = value.lastIndexOf("\\");
    if (index <= 0)
        return value;
    if (index === 2 && /^[A-Za-z]:\\/.test(value))
        return value.slice(0, 3);
    return value.slice(0, index);
}
