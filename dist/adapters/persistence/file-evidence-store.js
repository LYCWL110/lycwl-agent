import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../../domain/config/jsonc.js";
import { isSessionId } from "../../domain/identity/session-id.js";
import { assertProtectedBytes, assertProtectedValue, ProtectedDeliveryError, } from "../../services/security/guarded-delivery.js";
export const EVIDENCE_LIMITS = Object.freeze({
    processBytes: 8 * 1024 * 1024,
    manifestBytes: 16 * 1024,
});
/**
 * Finalize bytes before publishing the immutable manifest/reference. Crashes may
 * leave unreferenced files, never a reference to an unfinished capture. No raw
 * temporary file is written before the owned-key check.
 */
export function createFileEvidenceStore(options) {
    if (!isSessionId(options.sessionId))
        throw new Error("invalid_session_id");
    const anchor = path.resolve(options.sessionDirectory);
    const root = path.join(anchor, "attachments");
    async function refreshProtection() {
        try {
            await options.refreshOwnedKeys();
        }
        catch {
            throw new ProtectedDeliveryError("guard_failure");
        }
    }
    async function checkPath(target, allowMissing = false) {
        const resolved = path.resolve(target);
        const relative = path.relative(anchor, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("invalid_path");
        // Reject links at every existing component, including the Session root.
        const parsed = path.parse(resolved);
        let current = parsed.root;
        for (const part of resolved.slice(parsed.root.length).split(path.sep)) {
            current = path.join(current, part);
            try {
                const info = await lstat(current);
                if (info.isSymbolicLink())
                    throw new Error("invalid_path");
            }
            catch (error) {
                if (allowMissing && hasCode(error, "ENOENT"))
                    return;
                throw error;
            }
        }
        if ((await realpath(resolved)).toLowerCase() !== resolved.toLowerCase())
            throw new Error("invalid_path");
    }
    async function writeImmutable(file, bytes) {
        await checkPath(path.dirname(file));
        const handle = await open(file, "wx", 0o600);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1)
                throw new Error("invalid_path");
            await handle.writeFile(bytes);
            await handle.sync();
            await checkPath(file);
            const after = await lstat(file);
            if (after.dev !== info.dev || after.ino !== info.ino)
                throw new Error("invalid_path");
        }
        finally {
            await handle.close();
        }
    }
    async function readBounded(file, limit) {
        await checkPath(file);
        const before = await lstat(file);
        const handle = await open(file, "r");
        try {
            const info = await handle.stat();
            if (!info.isFile() ||
                info.nlink !== 1 ||
                info.dev !== before.dev ||
                info.ino !== before.ino ||
                info.size > limit)
                throw new Error("invalid_manifest");
            const bytes = Buffer.alloc(info.size + 1);
            let count = 0;
            while (count < bytes.length) {
                const read = await handle.read(bytes, count, bytes.length - count, count);
                if (read.bytesRead === 0)
                    break;
                count += read.bytesRead;
            }
            const after = await handle.stat();
            if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
                throw new Error("invalid_manifest");
            await checkPath(file);
            return bytes.subarray(0, count);
        }
        finally {
            await handle.close();
        }
    }
    return {
        async publishProcessOutput(input) {
            const total = input.stdout.byteLength + input.stderr.byteLength;
            if (total > EVIDENCE_LIMITS.processBytes)
                return { ok: false, code: "evidence_limit_exceeded" };
            // Snapshot before awaiting a registry refresh; callers retain their arrays.
            const streams = [
                { stream: "stdout", bytes: Buffer.from(input.stdout) },
                { stream: "stderr", bytes: Buffer.from(input.stderr) },
            ];
            try {
                await refreshProtection();
                for (const { bytes } of streams)
                    assertProtectedBytes(options.ownedKeys, bytes);
                const captureId = randomUUID();
                const attachments = streams.map(({ stream, bytes }) => ({
                    stream,
                    ref: {
                        kind: "attachment_bytes",
                        attachmentId: `${captureId}-${stream}`,
                        sha256: sha256(bytes),
                        byteLength: bytes.length,
                        start: 0,
                        end: bytes.length,
                    },
                }));
                const evidence = {
                    captureId,
                    manifestSha256: null,
                    capturedBytes: total,
                    rawComplete: true,
                    rawTruncationReason: null,
                    attachments,
                };
                const manifest = {
                    schemaVersion: 1,
                    sessionId: options.sessionId,
                    toolCallId: input.toolCallId,
                    evidence,
                };
                assertProtectedValue(options.ownedKeys, manifest);
                const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
                if (bytes.length > EVIDENCE_LIMITS.manifestBytes)
                    throw new Error("manifest_limit");
                await checkPath(root, true);
                await mkdir(root, { recursive: true, mode: 0o700 });
                await checkPath(root);
                for (const [index, stream] of streams.entries()) {
                    // Check the current registry again at each write, including rotations.
                    await refreshProtection();
                    assertProtectedBytes(options.ownedKeys, stream.bytes);
                    assertProtectedValue(options.ownedKeys, manifest);
                    const attachment = attachments[index];
                    if (attachment === undefined)
                        throw new Error("invalid_manifest");
                    await writeImmutable(path.join(root, attachment.ref.attachmentId), stream.bytes);
                }
                await refreshProtection();
                for (const stream of streams)
                    assertProtectedBytes(options.ownedKeys, stream.bytes);
                assertProtectedBytes(options.ownedKeys, bytes);
                await writeImmutable(path.join(root, `${captureId}.json`), bytes);
                const published = { ...evidence, manifestSha256: sha256(bytes) };
                assertProtectedValue(options.ownedKeys, published);
                return { ok: true, evidence: published };
            }
            catch (error) {
                if (error instanceof ProtectedDeliveryError)
                    return { ok: false, code: "protected_delivery_blocked", reason: error.reason };
                return { ok: false, code: "evidence_storage_failed" };
            }
        },
        async verify(evidence, toolCallId) {
            try {
                if (!isCaptureId(evidence.captureId) ||
                    !/^[0-9a-f]{64}$/.test(evidence.manifestSha256 ?? ""))
                    return { ok: false, code: "invalid_manifest" };
                const bytes = await readBounded(path.join(root, `${evidence.captureId}.json`), EVIDENCE_LIMITS.manifestBytes);
                if (sha256(bytes) !== evidence.manifestSha256)
                    return { ok: false, code: "hash_mismatch" };
                const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                const parsed = parseJsonc(text);
                if (!parsed.ok)
                    return { ok: false, code: "invalid_manifest" };
                const expected = { ...evidence, manifestSha256: null };
                const manifest = JSON.parse(text);
                if (manifest.schemaVersion !== 1 ||
                    manifest.sessionId !== options.sessionId ||
                    typeof manifest.toolCallId !== "string" ||
                    manifest.toolCallId.length === 0 ||
                    (toolCallId !== undefined && manifest.toolCallId !== toolCallId) ||
                    JSON.stringify(manifest.evidence) !== JSON.stringify(expected) ||
                    evidence.attachments.length !== 2 ||
                    !evidence.rawComplete ||
                    evidence.rawTruncationReason !== null)
                    return { ok: false, code: "invalid_manifest" };
                let total = 0;
                for (const [index, attachment] of evidence.attachments.entries()) {
                    const stream = index === 0 ? "stdout" : "stderr";
                    const ref = attachment.ref;
                    if (attachment.stream !== stream ||
                        ref.kind !== "attachment_bytes" ||
                        ref.attachmentId !== `${evidence.captureId}-${stream}` ||
                        !Number.isSafeInteger(ref.byteLength) ||
                        ref.byteLength < 0 ||
                        ref.byteLength > EVIDENCE_LIMITS.processBytes - total ||
                        ref.start !== 0 ||
                        ref.end !== ref.byteLength)
                        return { ok: false, code: "invalid_manifest" };
                    const content = await readBounded(path.join(root, ref.attachmentId), ref.byteLength);
                    if (content.length !== ref.byteLength || sha256(content) !== ref.sha256)
                        return { ok: false, code: "hash_mismatch" };
                    total += content.length;
                }
                return total === evidence.capturedBytes
                    ? { ok: true }
                    : { ok: false, code: "invalid_manifest" };
            }
            catch (error) {
                return {
                    ok: false,
                    code: hasCode(error, "ENOENT") ? "attachment_missing" : "invalid_manifest",
                };
            }
        },
    };
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function hasCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isCaptureId(value) {
    return value !== null && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
