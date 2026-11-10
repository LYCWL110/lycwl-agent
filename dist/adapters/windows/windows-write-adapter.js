import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.js";
export function createWindowsWriteAdapter(options) {
    const { workspaceRoot } = options;
    async function targetPath(relativePath) {
        const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
        if (!supplied.ok || !supplied.value.withinWorkspace)
            throw new Error("invalid_path");
        const parent = await realpath(path.dirname(supplied.value.absolutePath));
        const resolved = resolveWorkspacePath(workspaceRoot, parent);
        if (!resolved.ok || !resolved.value.withinWorkspace)
            throw new Error("invalid_path");
        const parentInfo = await lstat(parent, { bigint: true });
        return {
            absolutePath: supplied.value.absolutePath,
            parentKey: `${parent}:${parentInfo.dev}:${parentInfo.ino}`,
        };
    }
    /** Facts for conflict detection: existence plus the current content hash. */
    async function inspectTarget(relativePath) {
        const supplied = await targetPath(relativePath);
        let stats;
        try {
            stats = await lstat(supplied.absolutePath, { bigint: true });
        }
        catch (error) {
            if (isNotFound(error))
                return { exists: false, sha256: null, stateKey: supplied.parentKey };
            throw new Error(mapWriteError(error));
        }
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new Error("invalid_path");
        try {
            const bytes = await readFile(supplied.absolutePath);
            return {
                exists: true,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                stateKey: `${supplied.parentKey}:${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`,
            };
        }
        catch (error) {
            throw new Error(mapWriteError(error));
        }
    }
    async function readBytes(relativePath) {
        const supplied = await targetPath(relativePath);
        const info = await lstat(supplied.absolutePath);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error("invalid_path");
        try {
            return await readFile(supplied.absolutePath);
        }
        catch (error) {
            throw new Error(mapWriteError(error));
        }
    }
    /** Snapshot shape used by apply_patch preflight. */
    async function inspectPatchTarget(relativePath) {
        const supplied = await targetPath(relativePath);
        const before = await inspectTarget(relativePath);
        let bytes;
        let sha256;
        try {
            if (!before.exists)
                throw Object.assign(new Error("not_found"), { code: "ENOENT" });
            bytes = await readFile(supplied.absolutePath);
            sha256 = createHash("sha256").update(bytes).digest("hex");
        }
        catch (error) {
            if (isNotFound(error)) {
                return {
                    path: relativePath,
                    exists: false,
                    sha256: null,
                    encoding: "utf-8",
                    lineEnding: "lf",
                    bytes: new Uint8Array(),
                    ...(before.stateKey === undefined ? {} : { stateKey: before.stateKey }),
                };
            }
            throw new Error(mapWriteError(error));
        }
        const format = detectFormat(bytes);
        if (sha256 !== before.sha256)
            throw new Error("file_conflict");
        return {
            path: relativePath,
            exists: true,
            sha256,
            encoding: format.encoding,
            lineEnding: format.lineEnding,
            bytes,
            ...(before.stateKey === undefined ? {} : { stateKey: before.stateKey }),
        };
    }
    /**
     * Write finished bytes with a same-volume temp file and atomic rename.
     *
     * Recheck the bound content and identity before staging and before replacement.
     * These checks do not provide an atomic compare-and-swap against external writers.
     */
    async function writeBytes(relativePath, bytes, expected) {
        const supplied = resolveWorkspacePath(workspaceRoot, relativePath);
        if (!supplied.ok)
            return { ok: false, code: "invalid_path" };
        if (!supplied.value.withinWorkspace)
            return { ok: false, code: "invalid_path" };
        const target = supplied.value.absolutePath;
        const directory = path.dirname(target);
        async function unchanged() {
            if (expected === undefined)
                return true;
            try {
                const current = await inspectTarget(relativePath);
                return typeof expected === "object" && expected !== null
                    ? current.sha256 === expected.sha256 && current.stateKey === expected.stateKey
                    : current.sha256 === expected;
            }
            catch {
                return false;
            }
        }
        try {
            await targetPath(relativePath);
        }
        catch {
            return { ok: false, code: "invalid_path" };
        }
        if (!(await unchanged()))
            return { ok: false, code: "file_conflict" };
        const tempPath = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
        let handle = null;
        try {
            handle = await open(tempPath, "wx");
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = null;
        }
        catch (error) {
            if (handle !== null)
                await handle.close().catch(() => undefined);
            await unlink(tempPath).catch(() => undefined);
            return { ok: false, code: mapWriteError(error) };
        }
        try {
            if (!(await unchanged())) {
                await unlink(tempPath).catch(() => undefined);
                return { ok: false, code: "file_conflict" };
            }
            await rename(tempPath, target);
        }
        catch (error) {
            await unlink(tempPath).catch(() => undefined);
            return { ok: false, code: mapWriteError(error) };
        }
        return { ok: true };
    }
    return { inspectTarget, inspectPatchTarget, readBytes, writeBytes };
}
function isNotFound(error) {
    return (typeof error === "object" && error !== null && error.code === "ENOENT");
}
function mapWriteError(error) {
    if (typeof error !== "object" || error === null)
        return "write_failed";
    const code = error.code;
    if (typeof code !== "string")
        return "write_failed";
    switch (code) {
        case "ENOENT":
            return "not_found";
        case "EACCES":
        case "EPERM":
            return "access_denied";
        case "EBUSY":
        case "EEXIST":
            return "locked";
        case "ENOSPC":
            return "write_failed";
        default:
            return "write_failed";
    }
}
function detectFormat(bytes) {
    const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const hasUtf16Le = bytes[0] === 0xff && bytes[1] === 0xfe;
    const hasUtf16Be = bytes[0] === 0xfe && bytes[1] === 0xff;
    const encoding = hasUtf16Le ? "utf-16le" : hasUtf16Be ? "utf-16be" : "utf-8";
    const body = bytes.subarray(hasUtf8Bom ? 3 : hasUtf16Le || hasUtf16Be ? 2 : 0);
    const text = Buffer.from(body).toString("utf8");
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
    const cr = (text.match(/\r(?!\n)/g) ?? []).length;
    const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
    const lineEnding = kinds === 0 ? "none" : kinds > 1 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "cr";
    return { encoding, lineEnding };
}
