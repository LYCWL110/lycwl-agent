import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canSnapshot, SNAPSHOT_LIMITS, } from "../../domain/persistence/snapshot.js";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.js";
export function createSnapshotStore(options) {
    const nowUtc = options.nowUtc ?? (() => new Date().toISOString());
    const root = path.join(options.sessionDirectory, "snapshots");
    const budgets = new Map();
    const runDirectory = (runId) => path.join(root, safeSegment(runId));
    const indexPath = (runId) => path.join(runDirectory(runId), "index.json");
    async function readIndex(runId) {
        try {
            const text = await readFile(indexPath(runId), "utf8");
            const parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null)
                return { entries: [] };
            const entries = parsed["entries"];
            if (!Array.isArray(entries))
                return { entries: [] };
            return { entries: entries };
        }
        catch {
            return { entries: [] };
        }
    }
    async function writeIndex(runId, index) {
        await mkdir(runDirectory(runId), { recursive: true });
        await writeFile(indexPath(runId), JSON.stringify(index), "utf8");
    }
    return {
        async capture(input) {
            const segment = safeRelativePath(input.relativePath, isPosixWorkspaceRoot(options.workspaceRoot));
            if (segment === null)
                return { ok: false, code: "capture_failed" };
            const index = await readIndex(input.runId);
            // The first capture of a path wins: it holds the state before the Run touched
            // the file, which is what a revert to the Run's start means.
            if (index.entries.some((entry) => entry.path === segment)) {
                const existing = index.entries.find((entry) => entry.path === segment);
                return existing === undefined
                    ? { ok: false, code: "capture_failed" }
                    : { ok: true, entry: existing };
            }
            const absolute = path.join(options.workspaceRoot, ...segment.split("/"));
            let bytes = null;
            let byteLength = 0;
            try {
                const info = await stat(absolute);
                if (info.isFile()) {
                    byteLength = info.size;
                    const allowed = canSnapshot(budgets.get(input.runId) ?? { files: 0, bytes: 0 }, byteLength);
                    if (!allowed.ok)
                        return allowed;
                    bytes = new Uint8Array(await readFile(absolute));
                }
            }
            catch (error) {
                if (!isNotFound(error))
                    return { ok: false, code: "capture_failed" };
                // Absent: a creation. Reverting deletes it.
            }
            const sha256 = bytes === null ? EMPTY_DIGEST : createHash("sha256").update(bytes).digest("hex");
            const entry = {
                path: segment,
                bytes,
                byteLength,
                sha256,
                capturedAtUtc: nowUtc(),
            };
            if (bytes !== null) {
                const contentPath = path.join(runDirectory(input.runId), `${sha256}.bin`);
                try {
                    await mkdir(runDirectory(input.runId), { recursive: true });
                    // `wx` would fail on a second capture of identical content; content
                    // addressing means the existing file is already correct.
                    await writeFile(contentPath, bytes, { flag: "wx" }).catch((error) => {
                        if (!isExists(error))
                            throw error;
                    });
                }
                catch {
                    return { ok: false, code: "capture_failed" };
                }
            }
            await writeIndex(input.runId, { entries: [...index.entries, entry] });
            budgets.set(input.runId, {
                files: (budgets.get(input.runId)?.files ?? 0) + 1,
                bytes: (budgets.get(input.runId)?.bytes ?? 0) + byteLength,
            });
            return { ok: true, entry };
        },
        async list(runId) {
            return (await readIndex(runId)).entries;
        },
        async read(runId, entry) {
            if (entry.bytes === null)
                return null;
            try {
                const bytes = new Uint8Array(await readFile(path.join(runDirectory(runId), `${entry.sha256}.bin`)));
                // Verify before handing bytes to a restore: a damaged snapshot must not be
                // written over a working file.
                const digest = createHash("sha256").update(bytes).digest("hex");
                return digest === entry.sha256 ? bytes : null;
            }
            catch {
                return null;
            }
        },
        async discard(runId) {
            budgets.delete(runId);
            await rm(runDirectory(runId), { recursive: true, force: true }).catch(() => undefined);
        },
    };
}
const EMPTY_DIGEST = createHash("sha256").update(new Uint8Array()).digest("hex");
/**
 * Normalize a workspace-relative path.
 *
 * Rejects anything that could escape the workspace, because a snapshot writes into
 * the workspace on revert: a `..` segment would turn undo into an arbitrary write.
 */
function safeRelativePath(value, posix = false) {
    if (value.length === 0 || value.length > 1_024)
        return null;
    const normalized = posix ? value : value.replace(/\\/gu, "/");
    if (normalized.startsWith("/"))
        return null;
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
        return null;
    }
    return segments.join("/");
}
function safeSegment(value) {
    const cleaned = value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 128);
    return cleaned.length === 0 ? "unknown" : cleaned;
}
function isNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isExists(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
export { SNAPSHOT_LIMITS };
