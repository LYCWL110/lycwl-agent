import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { BATCH_LIMITS, } from "../../domain/mutation/batch.js";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.js";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
export function createWindowsMutationAdapter(options) {
    const { workspaceRoot } = options;
    async function checkedPath(requested) {
        const supplied = resolveWorkspacePath(workspaceRoot, requested);
        if (!supplied.ok || !supplied.value.withinWorkspace)
            throw new Error("invalid_path");
        const parent = path.dirname(supplied.value.absolutePath);
        const resolvedParent = await realpath(parent);
        const checked = resolveWorkspacePath(workspaceRoot, resolvedParent);
        if (!checked.ok || !checked.value.withinWorkspace)
            throw new Error("invalid_path");
        // Refuse reparse ancestors, including aliases that happen to resolve inside.
        // A stable lexical path must not conceal the actual mutation destination.
        let current = parent;
        while (true) {
            const stats = await lstat(current, { bigint: true });
            if (!stats.isDirectory() || stats.isSymbolicLink())
                throw new Error("reparse_point_unsupported");
            if (sameIdentityText(current, workspaceRoot))
                break;
            const next = path.dirname(current);
            if (next === current)
                throw new Error("invalid_path");
            current = next;
        }
        const parentStats = await lstat(resolvedParent, { bigint: true });
        return {
            absolutePath: path.join(resolvedParent, path.basename(supplied.value.absolutePath)),
            parentKey: `${resolvedParent}:${parentStats.dev}:${parentStats.ino}`,
        };
    }
    async function versionOf(target) {
        const resolved = await realpath(target);
        const checked = resolveWorkspacePath(workspaceRoot, resolved);
        if (!checked.ok || !checked.value.withinWorkspace)
            throw new Error("invalid_path");
        const stats = await lstat(target, { bigint: true });
        if (stats.isSymbolicLink())
            throw new Error("reparse_point_unsupported");
        const content = stats.isFile()
            ? createHash("sha256")
                .update(await readFile(target))
                .digest("hex")
            : "";
        return `${resolved}:${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}:${content}`;
    }
    async function inspectDeleteTargets(requested) {
        const facts = [];
        for (const candidate of requested) {
            facts.push(await inspectDeleteTarget(candidate));
        }
        return facts;
    }
    async function inspectDeleteTarget(relativePath) {
        const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
        if (!supplied.ok) {
            return {
                path: relativePath,
                exists: false,
                isDirectory: false,
                isSymbolicLink: false,
                isEmptyDirectory: false,
            };
        }
        let stats;
        try {
            stats = await lstat(supplied.value.absolutePath, { bigint: true });
        }
        catch {
            return {
                path: relativePath,
                exists: false,
                isDirectory: false,
                isSymbolicLink: false,
                isEmptyDirectory: false,
            };
        }
        const isSymbolicLink = stats.isSymbolicLink();
        const isDirectory = stats.isDirectory();
        let isEmptyDirectory = false;
        if (isDirectory) {
            try {
                const children = await readdir(supplied.value.absolutePath);
                isEmptyDirectory = children.length === 0;
            }
            catch {
                isEmptyDirectory = false;
            }
        }
        return {
            path: relativePath,
            exists: true,
            isDirectory,
            isSymbolicLink,
            isEmptyDirectory,
            ...(!isSymbolicLink ? { stateKey: await versionOf(supplied.value.absolutePath) } : {}),
        };
    }
    /** Delete exactly one ordinary file or one empty directory. */
    async function deletePath(relativePath) {
        const supplied = await checkedPath(relativePath);
        const stats = await lstat(supplied.absolutePath, { bigint: true });
        if (stats.isSymbolicLink())
            throw new Error("reparse_point_unsupported");
        if (stats.isDirectory()) {
            const children = await readdir(supplied.absolutePath);
            if (children.length > 0)
                throw new Error("directory_not_empty");
            await rmdir(supplied.absolutePath);
            return;
        }
        if (!stats.isFile())
            throw new Error("not_a_regular_file");
        await unlink(supplied.absolutePath);
    }
    async function inspectRename(from, to) {
        const empty = {
            from,
            to,
            sourceExists: false,
            targetExists: false,
            sameVolume: false,
            sourceIsSymbolicLink: false,
            treeEntries: 0,
            manifestBytes: 0,
            targetInsideSource: false,
            aliasAmbiguous: false,
        };
        const suppliedFrom = resolveWorkspacePath(workspaceRoot, from);
        const suppliedTo = resolveWorkspacePath(workspaceRoot, to);
        if (!suppliedFrom.ok || !suppliedTo.ok)
            return empty;
        if (!suppliedFrom.value.withinWorkspace || !suppliedTo.value.withinWorkspace) {
            return empty;
        }
        const source = await checkedPath(from);
        const destination = await checkedPath(to);
        const fromPath = source.absolutePath;
        const toPath = destination.absolutePath;
        let sourceStats;
        try {
            sourceStats = await lstat(fromPath, { bigint: true });
        }
        catch {
            return empty;
        }
        const targetExists = await exists(toPath);
        const targetInsideSource = isPosixWorkspaceRoot(workspaceRoot)
            ? toPath === fromPath || toPath.startsWith(`${fromPath}/`)
            : toPath.toLowerCase().startsWith(`${fromPath.toLowerCase()}\\`) ||
                toPath.toLowerCase() === fromPath.toLowerCase();
        // Windows case-only renames resolve to the same identity and are refused.
        const aliasAmbiguous = sameIdentityText(fromPath, toPath);
        let treeEntries = 1;
        let manifestBytes = fromPath.length + toPath.length;
        let manifestKey = "";
        if (sourceStats.isDirectory()) {
            const counted = await countTree(fromPath);
            treeEntries = counted.entries;
            manifestBytes += counted.bytes;
            manifestKey = counted.digest;
        }
        return {
            from,
            to,
            sourceExists: true,
            targetExists,
            sameVolume: isPosixWorkspaceRoot(workspaceRoot)
                ? sourceStats.dev === (await lstat(path.dirname(toPath), { bigint: true })).dev
                : sameVolume(fromPath, toPath),
            sourceIsSymbolicLink: sourceStats.isSymbolicLink(),
            treeEntries,
            manifestBytes,
            targetInsideSource,
            aliasAmbiguous,
            ...(!sourceStats.isSymbolicLink()
                ? {
                    stateKey: `${await versionOf(fromPath)}:${source.parentKey}:${destination.parentKey}:${manifestKey}`,
                }
                : {}),
        };
    }
    /** Rename one same-volume pair, never overwriting an existing target. */
    async function renamePath(from, to) {
        const suppliedFrom = resolveWorkspacePath(workspaceRoot, from);
        const suppliedTo = resolveWorkspacePath(workspaceRoot, to);
        if (!suppliedFrom.ok || !suppliedTo.ok)
            throw new Error("invalid_path");
        if (!suppliedFrom.value.withinWorkspace || !suppliedTo.value.withinWorkspace) {
            throw new Error("invalid_path");
        }
        const source = await checkedPath(from);
        const destination = await checkedPath(to);
        const fromPath = source.absolutePath;
        const toPath = destination.absolutePath;
        const sourceStats = await lstat(fromPath, { bigint: true });
        if (sourceStats.isSymbolicLink())
            throw new Error("reparse_point_unsupported");
        // Re-check immediately before the single OS call.
        if (await exists(toPath))
            throw new Error("target_exists");
        if (isPosixWorkspaceRoot(workspaceRoot)
            ? sourceStats.dev !== (await lstat(path.dirname(toPath), { bigint: true })).dev
            : !sameVolume(fromPath, toPath))
            throw new Error("different_volume");
        if (isPosixWorkspaceRoot(workspaceRoot)
            ? toPath.startsWith(`${fromPath}/`)
            : toPath.toLowerCase().startsWith(`${fromPath.toLowerCase()}\\`)) {
            throw new Error("target_inside_source");
        }
        if (sameIdentityText(fromPath, toPath))
            throw new Error("target_exists");
        const counted = sourceStats.isDirectory()
            ? await countTree(fromPath)
            : { entries: 1, bytes: 0 };
        if (counted.entries > BATCH_LIMITS.maxRenameTreeEntries ||
            counted.bytes > BATCH_LIMITS.maxRenameManifestBytes) {
            throw new Error("tree_too_large");
        }
        if ((await checkedPath(from)).parentKey !== source.parentKey ||
            (await checkedPath(to)).parentKey !== destination.parentKey)
            throw new Error("invalid_path");
        await rename(fromPath, toPath);
    }
    return { inspectDeleteTargets, deletePath, inspectRename, renamePath };
}
async function exists(target) {
    try {
        await lstat(target, { bigint: true });
        return true;
    }
    catch {
        return false;
    }
}
async function countTree(root) {
    let entries = 0;
    let bytes = 0;
    const digest = createHash("sha256");
    const queue = [root];
    while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined)
            break;
        let children;
        try {
            children = (await readdir(current)).sort();
        }
        catch {
            throw new Error("operation_failed");
        }
        for (const child of children) {
            entries += 1;
            bytes += child.length;
            if (entries > BATCH_LIMITS.maxRenameTreeEntries)
                return { entries, bytes, digest: digest.digest("hex") };
            const childPath = path.join(current, child);
            try {
                const stats = await lstat(childPath, { bigint: true });
                if (stats.isSymbolicLink())
                    throw new Error("reparse_point_unsupported");
                digest.update(JSON.stringify([childPath, `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`]));
                if (stats.isDirectory() && !stats.isSymbolicLink())
                    queue.push(childPath);
            }
            catch {
                throw new Error("operation_failed");
            }
        }
    }
    return { entries, bytes, digest: digest.digest("hex") };
}
function sameVolume(left, right) {
    const drive = (value) => {
        const match = /^([A-Za-z]):/.exec(value);
        if (match !== null)
            return (match[1] ?? "").toUpperCase();
        if (value.startsWith("\\\\")) {
            const parts = value.slice(2).split("\\");
            return `\\\\${(parts[0] ?? "").toUpperCase()}\\${(parts[1] ?? "").toUpperCase()}`;
        }
        return null;
    };
    const leftDrive = drive(left);
    const rightDrive = drive(right);
    if (leftDrive === null || rightDrive === null)
        return false;
    return leftDrive === rightDrive;
}
/** True when the two paths differ only by case or trailing separators. */
function sameIdentityText(left, right) {
    if (isPosixWorkspaceRoot(left)) {
        return path.posix.resolve(left) === path.posix.resolve(right);
    }
    return left.replace(/\\+$/, "").toLowerCase() === right.replace(/\\+$/, "").toLowerCase();
}
