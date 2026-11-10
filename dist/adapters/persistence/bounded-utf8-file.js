import { open } from "node:fs/promises";
/** Bound allocation and actual reads, including files that grow after stat. */
export async function readBoundedUtf8(filePath, maxBytes) {
    let handle;
    try {
        handle = await open(filePath, "r");
        const stat = await handle.stat();
        if (!stat.isFile())
            return { ok: false, code: "unreadable" };
        if (stat.size > maxBytes)
            return { ok: false, code: "too_large" };
        const bytes = Buffer.alloc(maxBytes + 1);
        let total = 0;
        while (total < bytes.length) {
            const read = await handle.read(bytes, total, bytes.length - total, null);
            if (read.bytesRead === 0)
                break;
            total += read.bytesRead;
        }
        if (total > maxBytes)
            return { ok: false, code: "too_large" };
        try {
            return {
                ok: true,
                text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total)),
            };
        }
        catch {
            return { ok: false, code: "invalid_utf8" };
        }
    }
    catch (error) {
        return {
            ok: false,
            code: typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
                ? "missing"
                : "unreadable",
        };
    }
    finally {
        await handle?.close();
    }
}
