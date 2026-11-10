export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export async function captureConsistentSnapshot(source) {
    const beforeFailure = validateFacts(source.before);
    if (beforeFailure !== null)
        return { ok: false, code: beforeFailure };
    if (source.before.size > MAX_SNAPSHOT_BYTES) {
        return { ok: false, code: "file_too_large" };
    }
    let bytes;
    try {
        bytes = await source.read();
    }
    catch {
        return { ok: false, code: "read_failed" };
    }
    let after;
    try {
        after = typeof source.after === "function" ? await source.after() : source.after;
    }
    catch {
        return { ok: false, code: "read_failed" };
    }
    const afterFailure = validateFacts(after);
    if (afterFailure !== null)
        return { ok: false, code: afterFailure };
    if (!sameFacts(source.before, after)) {
        return { ok: false, code: "file_changed" };
    }
    if (bytes.byteLength !== source.before.size) {
        return { ok: false, code: "file_changed" };
    }
    return {
        ok: true,
        value: {
            bytes,
            identity: source.before.identity,
            size: source.before.size,
        },
    };
}
function validateFacts(facts) {
    if (facts.isSymbolicLink)
        return "symbolic_link";
    if (!facts.isFile)
        return "not_a_regular_file";
    if (!Number.isSafeInteger(facts.size) || facts.size < 0)
        return "file_changed";
    if (facts.identity.length === 0)
        return "file_changed";
    return null;
}
function sameFacts(left, right) {
    return (left.identity === right.identity &&
        left.size === right.size &&
        left.lastWriteTimeNs === right.lastWriteTimeNs &&
        left.isFile === right.isFile &&
        left.isSymbolicLink === right.isSymbolicLink);
}
