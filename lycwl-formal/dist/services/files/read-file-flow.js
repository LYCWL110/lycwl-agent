import { decideResolvedReadPermission, } from "../permission/resolved-read-policy.js";
import { captureConsistentSnapshot, MAX_SNAPSHOT_BYTES, } from "./consistent-snapshot.js";
import { createReadFileFact } from "./read-file-fact.js";
import { boundTextSnapshotForModel } from "./text-delivery.js";
import { readTextSnapshot } from "./text-snapshot.js";
export async function runReadFileFlow(request, dependencies) {
    let inspected;
    try {
        inspected = await dependencies.inspectTarget();
    }
    catch {
        return { ok: false, code: "read_failed" };
    }
    // `requestedPath` in the facts may be the resolved absolute path produced by a
    // real adapter, while the caller passes a workspace-relative path. Compare the
    // normalized forms so a legitimate adapter is not mistaken for a changed
    // precondition, without weakening the identity check on the resolved target.
    if (!sameRequestedPath(inspected.target.requestedPath, request.requestedPath)) {
        return { ok: false, code: "precondition_changed" };
    }
    const decision = decideResolvedReadPermission(request.workspaceRoot, inspected.target);
    if (decision.outcome === "invalid") {
        return { ok: false, code: "invalid_path" };
    }
    if (decision.outcome === "denied")
        return { ok: false, code: decision.code };
    if (inspected.snapshot.size > MAX_SNAPSHOT_BYTES) {
        return { ok: false, code: "file_too_large" };
    }
    if (decision.outcome === "approval_required") {
        const approval = await dependencies.approvals.decide({
            approvalId: request.approvalId,
            toolCallId: request.toolCallId,
            toolName: "read_file",
            safePreview: createPreview(decision.requestedPath, decision.resolvedPath, inspected.snapshot, decision.disclosureWarning),
        });
        if (approval !== "approved")
            return { ok: false, code: "approval_denied" };
        let before;
        try {
            before = await dependencies.inspectTarget();
        }
        catch {
            return { ok: false, code: "read_failed" };
        }
        const precondition = decideResolvedReadPermission(request.workspaceRoot, before.target);
        if (!sameDecision(decision, precondition) ||
            !sameResolvedTarget(before.target, inspected.target) ||
            !sameSnapshotFacts(before.snapshot, inspected.snapshot)) {
            return { ok: false, code: "precondition_changed" };
        }
        inspected = before;
    }
    const snapshot = await captureConsistentSnapshot({
        before: inspected.snapshot,
        read: dependencies.readBytes,
        after: async () => (await dependencies.inspectTarget()).snapshot,
    });
    if (!snapshot.ok)
        return { ok: false, code: snapshot.code };
    const text = readTextSnapshot(snapshot.value.bytes, {
        ...(request.startLine === undefined ? {} : { startLine: request.startLine }),
        ...(request.lineCount === undefined ? {} : { lineCount: request.lineCount }),
        ...(request.encoding === undefined ? {} : { encoding: request.encoding }),
    });
    if (!text.ok)
        return { ok: false, code: text.code };
    return {
        ok: true,
        value: createReadFileFact(request.snapshotId, boundTextSnapshotForModel(text.value)),
    };
}
export function sameDecision(left, right) {
    if (left.outcome !== right.outcome)
        return false;
    if (left.outcome === "approval_required" && right.outcome === "approval_required") {
        return left.reason === right.reason;
    }
    if (left.outcome === "invalid" && right.outcome === "invalid") {
        return left.code === right.code;
    }
    if (left.outcome === "denied" && right.outcome === "denied") {
        return left.code === right.code;
    }
    return left.outcome === "allowed" && right.outcome === "allowed";
}
export function sameResolvedTarget(left, right) {
    return (left.requestedPath.toLowerCase() === right.requestedPath.toLowerCase() &&
        left.resolvedPath.toLowerCase() === right.resolvedPath.toLowerCase() &&
        left.isDirectory === right.isDirectory &&
        left.isSymbolicLink === right.isSymbolicLink);
}
export function sameSnapshotFacts(left, right) {
    return (left.identity === right.identity &&
        left.size === right.size &&
        left.lastWriteTimeNs === right.lastWriteTimeNs &&
        left.isFile === right.isFile &&
        left.isSymbolicLink === right.isSymbolicLink);
}
function sameRequestedPath(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
function createPreview(requestedPath, resolvedPath, facts, warning) {
    return [
        "read_file",
        `requested=${requestedPath}`,
        `resolved=${resolvedPath}`,
        `identity=${facts.identity}`,
        `bytes=${facts.size}`,
        "capture=complete file snapshot up to 5 MiB",
        "delivery=selected lines, at most 20000 UTF-16 units",
        warning,
    ].join("\n");
}
