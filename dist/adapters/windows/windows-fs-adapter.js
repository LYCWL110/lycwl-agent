import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.js";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
export function createWindowsFsAdapter(options) {
    const { workspaceRoot } = options;
    /**
     * Inspect one target: validate the supplied path, resolve reparse points, then
     * report identity facts for the resolved path.
     */
    async function inspect(requestedPath) {
        const supplied = resolveWorkspacePath(workspaceRoot, requestedPath);
        if (!supplied.ok)
            return { ok: false, code: "invalid_path" };
        if (isPosixWorkspaceRoot(workspaceRoot)) {
            try {
                const linkFacts = await lstat(supplied.value.absolutePath, { bigint: true });
                if (linkFacts.isSymbolicLink()) {
                    return {
                        ok: true,
                        target: {
                            requestedPath: supplied.value.absolutePath,
                            resolvedPath: supplied.value.absolutePath,
                            isDirectory: false,
                            isSymbolicLink: true,
                        },
                        snapshot: {
                            identity: `${linkFacts.dev}:${linkFacts.ino}`,
                            size: Number(linkFacts.size),
                            lastWriteTimeNs: linkFacts.mtimeNs,
                            isFile: false,
                            isSymbolicLink: true,
                        },
                    };
                }
            }
            catch (error) {
                return { ok: false, code: mapError(error) };
            }
        }
        let resolvedPath;
        try {
            resolvedPath = await realpath(supplied.value.absolutePath);
        }
        catch (error) {
            const mapped = mapError(error);
            return { ok: false, code: mapped };
        }
        const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
        if (!resolved.ok)
            return { ok: false, code: "invalid_path" };
        let stats;
        try {
            stats = await lstat(resolved.value.absolutePath, { bigint: true });
        }
        catch (error) {
            return { ok: false, code: mapError(error) };
        }
        const isSymbolicLink = stats.isSymbolicLink();
        const isDirectory = stats.isDirectory();
        return {
            ok: true,
            target: {
                requestedPath: supplied.value.absolutePath,
                resolvedPath: resolved.value.absolutePath,
                isDirectory,
                isSymbolicLink,
            },
            snapshot: {
                identity: `${stats.dev.toString()}:${stats.ino.toString()}`,
                size: Number(stats.size),
                lastWriteTimeNs: stats.mtimeNs,
                isFile: stats.isFile(),
                isSymbolicLink,
            },
        };
    }
    return {
        workspaceRoot,
        inspect,
        /** True only when the adapter may read this target. */
        isReadable: (result) => result.ok && result.snapshot.isFile && !result.snapshot.isSymbolicLink,
        join: (relative) => path.join(workspaceRoot, relative),
    };
}
function mapError(error) {
    if (typeof error !== "object" || error === null)
        return "read_failed";
    const code = error.code;
    if (typeof code !== "string")
        return "read_failed";
    switch (code) {
        case "ENOENT":
            return "not_found";
        case "EACCES":
        case "EPERM":
            return "access_denied";
        case "EBUSY":
            return "locked";
        case "EISDIR":
            return "not_a_regular_file";
        default:
            return "read_failed";
    }
}
