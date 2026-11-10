import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
export async function undoSessionChanges(options) {
    const resolvedRoot = path.resolve(options.workspaceRoot);
    const reverted = new Set();
    const skipped = [];
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
                await writeFile(absolute, bytes);
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
