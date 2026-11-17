import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLinuxWriteAdapter } from "../adapters/linux/filesystem.js";
import { resolveWorkspacePath } from "../services/permission/workspace-path.js";
export async function undoSessionChanges(options) {
    const resolvedRoot = path.resolve(options.workspaceRoot);
    const reverted = new Set();
    const skipped = [];
    const linuxWriter = process.platform === "linux" ? createLinuxWriteAdapter({ workspaceRoot: resolvedRoot }) : null;
    for (const runId of options.runIds) {
        const entries = await options.store.list(runId);
        for (const entry of entries) {
            if (reverted.has(entry.path))
                continue;
            const absolute = path.resolve(resolvedRoot, ...entry.path.split("/"));
            // The prefix check must include the separator, or `workspace-evil` would pass
            // for a root of `workspace`.
            if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
                skipped.push(entry.path);
                continue;
            }
            if (linuxWriter !== null) {
                try {
                    const parent = await realpath(path.dirname(absolute));
                    const checked = resolveWorkspacePath(resolvedRoot, parent);
                    if (!checked.ok || !checked.value.withinWorkspace)
                        throw new Error("invalid_path");
                    const target = await lstat(absolute).catch((error) => {
                        if (error.code === "ENOENT")
                            return null;
                        throw error;
                    });
                    if (target !== null && (!target.isFile() || target.isSymbolicLink()))
                        throw new Error("invalid_path");
                }
                catch {
                    skipped.push(entry.path);
                    continue;
                }
            }
            if (entry.bytes === null) {
                // The file did not exist before this Run; undo removes it.
                await rm(absolute, { force: true }).catch(() => undefined);
                reverted.add(entry.path);
                continue;
            }
            const bytes = await options.store.read(runId, entry);
            if (bytes === null) {
                // A missing or damaged snapshot is not a reason to overwrite anything.
                skipped.push(entry.path);
                continue;
            }
            try {
                if (linuxWriter === null)
                    await writeFile(absolute, bytes);
                else {
                    const expected = await linuxWriter.inspectTarget(entry.path);
                    const restored = await linuxWriter.writeBytes(entry.path, bytes, expected);
                    if (!restored.ok)
                        throw new Error(restored.code);
                }
                reverted.add(entry.path);
            }
            catch {
                skipped.push(entry.path);
            }
        }
    }
    if (reverted.size === 0 && skipped.length === 0) {
        return { ok: false, code: "no_snapshots" };
    }
    if (reverted.size === 0)
        return { ok: false, code: "undo_failed" };
    return { ok: true, files: reverted.size, skipped };
}
