import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { decideResolvedReadPermission } from "../../services/permission/resolved-read-policy.js";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
const MAX_READ_BYTES = 5 * 1024 * 1024;
export function createWindowsFileReader(options) {
    const { workspaceRoot } = options;
    async function listDirectory(relativeDirectory) {
        // An empty path means the workspace root itself, matching the search tools.
        const requested = relativeDirectory.length === 0 ? "." : relativeDirectory;
        const supplied = resolveWorkspacePath(workspaceRoot, requested);
        if (!supplied.ok)
            return { ok: false, code: "invalid_path" };
        if (!supplied.value.withinWorkspace)
            return { ok: false, code: "invalid_path" };
        // Resolve reparse points first: a junction must not pull outside content in.
        let resolvedPath;
        try {
            resolvedPath = await realpath(supplied.value.absolutePath);
        }
        catch (error) {
            return { ok: false, code: mapDirectoryError(error) };
        }
        const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
        if (!resolved.ok || !resolved.value.withinWorkspace) {
            return { ok: false, code: "invalid_path" };
        }
        let names;
        try {
            names = await readdir(resolved.value.absolutePath);
        }
        catch (error) {
            return { ok: false, code: mapDirectoryError(error) };
        }
        const prefix = toPosixRelative(workspaceRoot, resolved.value.absolutePath);
        const entries = [];
        for (const name of names) {
            const childPath = path.join(resolved.value.absolutePath, name);
            let stats;
            try {
                stats = await lstat(childPath, { bigint: true });
            }
            catch {
                // A child that vanished between readdir and lstat is simply omitted.
                continue;
            }
            // Reparse points are reported as directories but never traversed by
            // callers; the entry kind stays honest.
            const kind = stats.isDirectory() ? "directory" : "file";
            entries.push({
                path: prefix.length === 0 ? name : `${prefix}/${name}`,
                kind,
                ...(stats.isSymbolicLink() ? { isReparse: true } : {}),
            });
        }
        return { ok: true, entries };
    }
    /**
     * Read one regular file with identity checks before and after, refusing links
     * and oversized targets. Reuses the same facts shape as the injected flow.
     */
    async function readFile(relativePath, readOptions = {}) {
        const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
        if (!supplied.ok)
            return { ok: false, code: "invalid_path" };
        let resolvedPath;
        try {
            resolvedPath = await realpath(supplied.value.absolutePath);
        }
        catch (error) {
            return { ok: false, code: mapFileReadError(error) };
        }
        const resolved = resolveWorkspacePath(workspaceRoot, resolvedPath);
        if (!resolved.ok)
            return { ok: false, code: "invalid_path" };
        let before;
        try {
            before = await lstat(resolved.value.absolutePath, { bigint: true });
        }
        catch (error) {
            return { ok: false, code: mapFileReadError(error) };
        }
        if (before.isSymbolicLink())
            return { ok: false, code: "symbolic_link" };
        if (!before.isFile())
            return { ok: false, code: "not_a_regular_file" };
        if (readOptions.unapproved &&
            decideResolvedReadPermission(workspaceRoot, {
                requestedPath: supplied.value.absolutePath,
                resolvedPath: resolved.value.absolutePath,
                isDirectory: false,
                isSymbolicLink: false,
            }).outcome !== "allowed") {
            return { ok: false, code: "approval_required" };
        }
        const maxBytes = Math.min(readOptions.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
        if (before.size > BigInt(maxBytes))
            return { ok: false, code: "file_too_large" };
        let handle;
        try {
            handle = await open(resolved.value.absolutePath, "r");
        }
        catch (error) {
            return { ok: false, code: mapFileReadError(error) };
        }
        try {
            const opened = await handle.stat({ bigint: true });
            if (opened.ino !== before.ino || opened.dev !== before.dev) {
                return { ok: false, code: "file_changed" };
            }
            const bytes = await handle.readFile();
            const after = await handle.stat({ bigint: true });
            if (after.ino !== before.ino ||
                after.dev !== before.dev ||
                after.size !== before.size ||
                after.mtimeNs !== before.mtimeNs) {
                return { ok: false, code: "file_changed" };
            }
            if (bytes.byteLength > maxBytes)
                return { ok: false, code: "file_too_large" };
            return {
                ok: true,
                bytes,
                snapshot: {
                    identity: `${before.dev.toString()}:${before.ino.toString()}`,
                    size: Number(before.size),
                    lastWriteTimeNs: before.mtimeNs,
                    isFile: true,
                    isSymbolicLink: false,
                },
            };
        }
        catch (error) {
            return { ok: false, code: mapFileReadError(error) };
        }
        finally {
            await handle.close();
        }
    }
    /** Read a text file for grep; returns null when the file is not readable. */
    async function readText(relativePath) {
        const result = await readFile(relativePath);
        if (!result.ok)
            return null;
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        }
        catch {
            return null;
        }
    }
    return { listDirectory, readFile, readText };
}
function toPosixRelative(workspaceRoot, absolutePath) {
    const relative = path.relative(workspaceRoot, absolutePath);
    return relative.replace(/\\/g, "/").replace(/\/+$/, "");
}
function mapDirectoryError(error) {
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
        case "ENOTDIR":
            return "not_a_directory";
        default:
            return "read_failed";
    }
}
function mapFileReadError(error) {
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
        case "ENOTDIR":
            return "not_a_regular_file";
        default:
            return "read_failed";
    }
}
