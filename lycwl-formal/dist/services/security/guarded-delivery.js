import { createStreamGuard, } from "../../domain/security/owned-key-guard.js";
export class ProtectedDeliveryError extends Error {
    reason;
    constructor(reason) {
        super("protected_delivery_blocked");
        this.reason = reason;
    }
}
/** Lossless byte checks include reviewed UTF-16 representations, not UTF-8 alone. */
export function assertProtectedBytes(registry, bytes) {
    try {
        const keys = registry.keys.flatMap((key) => {
            if (typeof key.value !== "string" ||
                key.value.length === 0 ||
                (key.byteEncoding === "latin1" && [...key.value].some((char) => char.charCodeAt(0) > 0xff)))
                throw new ProtectedDeliveryError("guard_failure");
            return [
                { ...key, value: Buffer.from(key.value, "utf8").toString("latin1") },
                ...(key.byteEncoding === "latin1" ? [key] : []),
            ];
        });
        const guard = createStreamGuard({ keys });
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const chunk = Buffer.from(bytes.subarray(offset, offset + 64 * 1024)).toString("latin1");
            const result = guard.push(chunk);
            if (result.blocked)
                throw new ProtectedDeliveryError(result.reason ?? "guard_failure");
        }
        const result = guard.flush();
        if (result.blocked)
            throw new ProtectedDeliveryError(result.reason ?? "guard_failure");
    }
    catch (error) {
        if (error instanceof ProtectedDeliveryError)
            throw error;
        throw new ProtectedDeliveryError("guard_failure");
    }
}
/** Check decoded string fields as well as their serialized representation. */
export function assertProtectedValue(registry, value) {
    try {
        const serialized = JSON.stringify(value, (key, entry) => {
            for (const text of [key, ...(typeof entry === "string" ? [entry] : [])]) {
                const guarded = guardText(registry, text);
                if (guarded.kind === "blocked")
                    throw new ProtectedDeliveryError(guarded.reason);
            }
            return entry;
        });
        if (serialized !== undefined) {
            const guarded = guardText(registry, serialized);
            if (guarded.kind === "blocked")
                throw new ProtectedDeliveryError(guarded.reason);
        }
    }
    catch (error) {
        if (error instanceof ProtectedDeliveryError)
            throw error;
        throw new ProtectedDeliveryError("guard_failure");
    }
}
export function guardText(registry, text) {
    if (registry.keys.length === 0)
        return { kind: "delivered", text };
    // Chunk the input so the same streaming path is exercised for every exit.
    const guard = createStreamGuard(registry);
    let delivered = "";
    for (const chunk of splitIntoChunks(text)) {
        const result = guard.push(chunk);
        if (result.blocked) {
            return { kind: "blocked", reason: result.reason ?? "owned_key_detected" };
        }
        delivered += result.emitted;
    }
    const flushed = guard.flush();
    if (flushed.blocked) {
        return { kind: "blocked", reason: flushed.reason ?? "owned_key_detected" };
    }
    return { kind: "delivered", text: delivered + flushed.emitted };
}
function splitIntoChunks(text) {
    if (text.length === 0)
        return [];
    const chunks = [];
    const size = 512;
    for (let index = 0; index < text.length; index += size) {
        chunks.push(text.slice(index, index + size));
    }
    return chunks;
}
export function guardToolResultText(registry, status, text) {
    if (text === null)
        return { status, text: null, deliveryBlocked: false };
    const guarded = guardText(registry, text);
    if (guarded.kind === "blocked") {
        return { status, text: null, deliveryBlocked: true, reason: guarded.reason };
    }
    return { status, text: guarded.text, deliveryBlocked: false };
}
