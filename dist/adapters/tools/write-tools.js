import { createHash } from "node:crypto";
import { planCreateFile, planEditFile, } from "../../services/files/file-write.js";
export const CREATE_FILE_DEFINITION = {
    name: "create_file",
    version: "1",
    sideEffectClass: "filesystem_mutation",
    requiresApproval: true,
    concurrencySafe: false,
};
export const EDIT_FILE_DEFINITION = {
    name: "edit_file",
    version: "1",
    sideEffectClass: "filesystem_mutation",
    requiresApproval: true,
    concurrencySafe: false,
};
const DEFINITIONS = [CREATE_FILE_DEFINITION, EDIT_FILE_DEFINITION];
/** Codes that prove the sink refused before any byte was written. */
const KNOWN_PRE_WRITE_CODES = new Set([
    "invalid_path",
    "file_conflict",
    "access_denied",
    "not_found",
    "locked",
]);
export function createWriteTools(dependencies) {
    const prepared = new Map();
    const refused = new Map();
    return {
        getDefinition(toolName) {
            return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
        },
        async preview(request) {
            prepared.delete(request.toolCallId);
            refused.delete(request.toolCallId);
            const planned = await planFor(dependencies, request);
            if (!planned.ok) {
                refused.set(request.toolCallId, {
                    args: JSON.stringify(request.arguments),
                    code: planned.code,
                });
                return `${request.toolName}: ${planned.code}`;
            }
            prepared.set(request.toolCallId, {
                args: JSON.stringify(request.arguments),
                plan: planned.value,
            });
            return renderPreview(request.toolName, planned.value);
        },
        discardApproval: (id) => {
            prepared.delete(id);
            refused.delete(id);
        },
        async revalidateApproval(request) {
            const saved = prepared.get(request.toolCallId);
            if (saved === undefined)
                return refused.get(request.toolCallId)?.args === JSON.stringify(request.arguments);
            if (saved.args !== JSON.stringify(request.arguments))
                return false;
            const current = await dependencies.inspectTarget(saved.plan.path);
            return sameTargetState(current, saved.plan.expectedBefore);
        },
        async execute(request) {
            const saved = prepared.get(request.toolCallId);
            const refusal = refused.get(request.toolCallId);
            prepared.delete(request.toolCallId);
            refused.delete(request.toolCallId);
            if (refusal !== undefined)
                return { status: "failed", safeCode: refusal.code, text: null };
            if (request.approvalGranted && saved === undefined)
                return { status: "failed", safeCode: "approval_precondition_missing", text: null };
            if (request.signal?.aborted)
                return { status: "failed", safeCode: "tool_cancelled", text: null };
            if (saved !== undefined && saved.args !== JSON.stringify(request.arguments)) {
                return { status: "failed", safeCode: "file_conflict", text: null };
            }
            const planned = saved === undefined
                ? await planFor(dependencies, request)
                : { ok: true, value: saved.plan };
            if (!planned.ok) {
                return { status: "failed", safeCode: planned.code, text: null };
            }
            const plan = planned.value;
            // Re-check the precondition against the plan's recorded hash before write.
            const before = await dependencies.inspectTarget(plan.path);
            if (!sameTargetState(before, plan.expectedBefore)) {
                return { status: "failed", safeCode: "file_conflict", text: null };
            }
            try {
                if (request.signal?.aborted)
                    return { status: "failed", safeCode: "tool_cancelled", text: null };
                await dependencies.writeBytes(plan.path, plan.bytes, plan.expectedBefore);
            }
            catch (error) {
                // Distinguish a known pre-write refusal from an uncertain outcome: a
                // rejected path or denied access means nothing was written, while any
                // other failure may have left a partial effect.
                const code = error instanceof Error ? error.message : "";
                if (KNOWN_PRE_WRITE_CODES.has(code)) {
                    return { status: "failed", safeCode: code, text: null };
                }
                return { status: "outcome_unknown", safeCode: "write_outcome_unknown" };
            }
            return { status: "succeeded", text: renderResult(plan) };
        },
    };
}
async function planFor(dependencies, request) {
    if (request.toolName === CREATE_FILE_DEFINITION.name) {
        return planCreate(dependencies, request.arguments);
    }
    if (request.toolName === EDIT_FILE_DEFINITION.name) {
        return planEdit(dependencies, request.arguments);
    }
    return { ok: false, code: "unknown_tool" };
}
async function planCreate(dependencies, args) {
    if (typeof args !== "object" || args === null)
        return { ok: false, code: "invalid_arguments" };
    const record = args;
    const path = record["path"];
    if (typeof path !== "string" || path.length === 0) {
        return { ok: false, code: "invalid_arguments" };
    }
    const content = record["content"];
    if (typeof content !== "string")
        return { ok: false, code: "invalid_arguments" };
    const encoding = record["encoding"];
    const lineEnding = record["lineEnding"];
    const plan = planCreateFile({
        content,
        ...(encoding === undefined ? {} : { encoding: encoding }),
        ...(lineEnding === undefined
            ? {}
            : { lineEnding: lineEnding }),
    });
    if (!plan.ok)
        return { ok: false, code: plan.code };
    const target = await dependencies.inspectTarget(path);
    // create_file never overwrites an existing target.
    if (target.exists)
        return { ok: false, code: "file_conflict" };
    const value = plan.value;
    return {
        ok: true,
        value: {
            path,
            bytes: value.bytes,
            sha256: value.sha256,
            byteLength: value.byteLength,
            expectedBefore: target,
            summary: {
                operation: "create_file",
                path,
                encoding: value.encoding,
                bom: value.bom,
                lineEnding: value.lineEnding,
                bytes: value.byteLength,
            },
        },
    };
}
async function planEdit(dependencies, args) {
    if (typeof args !== "object" || args === null)
        return { ok: false, code: "invalid_arguments" };
    const record = args;
    const path = record["path"];
    if (typeof path !== "string" || path.length === 0) {
        return { ok: false, code: "invalid_arguments" };
    }
    const oldText = record["oldText"];
    const newText = record["newText"];
    if (typeof oldText !== "string" || typeof newText !== "string") {
        return { ok: false, code: "invalid_arguments" };
    }
    const target = await dependencies.inspectTarget(path);
    if (!target.exists)
        return { ok: false, code: "not_found" };
    const originalBytes = await dependencies.readBytes(path);
    const originalSha = createHash("sha256").update(originalBytes).digest("hex");
    if (target.sha256 !== null && target.sha256 !== originalSha) {
        return { ok: false, code: "file_conflict" };
    }
    const declared = detectFormat(originalBytes);
    const plan = planEditFile({
        originalBytes,
        encoding: record["encoding"] ?? declared.encoding,
        bom: record["bom"] === true || declared.bom,
        lineEnding: declared.lineEnding,
        oldText,
        newText,
        replaceAll: record["replaceAll"] === true,
        ...(record["expectedOccurrences"] === undefined
            ? {}
            : { expectedOccurrences: record["expectedOccurrences"] }),
        ...(record["insertedLineEnding"] === undefined
            ? {}
            : { insertedLineEnding: record["insertedLineEnding"] }),
    });
    if (!plan.ok)
        return { ok: false, code: plan.code };
    const value = plan.value;
    return {
        ok: true,
        value: {
            path,
            bytes: value.bytes,
            sha256: value.newSha256,
            byteLength: value.byteLength,
            expectedBefore: target,
            summary: {
                operation: "edit_file",
                path,
                encoding: value.encoding,
                bom: value.bom,
                lineEnding: value.lineEnding,
                replacedOccurrences: value.replacedOccurrences,
                oldSha256: value.oldSha256,
                newSha256: value.newSha256,
                bytes: value.byteLength,
            },
        },
    };
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
    return { encoding, bom: hasUtf8Bom || hasUtf16Le || hasUtf16Be, lineEnding };
}
function sameTargetState(left, right) {
    return (left.exists === right.exists && left.sha256 === right.sha256 && left.stateKey === right.stateKey);
}
function renderPreview(toolName, plan) {
    return [
        toolName,
        ...Object.entries(plan.summary).map(([key, value]) => `${key}=${String(value)}`),
        "effect=replaces file bytes on disk",
    ].join("\n");
}
function renderResult(plan) {
    return [
        `${String(plan.summary["operation"])}: ${plan.path}`,
        `bytes=${plan.byteLength}`,
        `sha256=${plan.sha256}`,
        ...Object.entries(plan.summary)
            .filter(([key]) => key !== "operation" && key !== "path" && key !== "bytes")
            .map(([key, value]) => `${key}=${String(value)}`),
    ].join("\n");
}
