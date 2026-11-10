import { classifySensitiveRead, resolveWorkspacePath, } from "./workspace-path.js";
export function decideResolvedReadPermission(workspaceRoot, target) {
    const supplied = resolveWorkspacePath(workspaceRoot, target.requestedPath);
    if (!supplied.ok)
        return { outcome: "invalid", code: supplied.code };
    const resolved = resolveWorkspacePath(workspaceRoot, target.resolvedPath);
    if (!resolved.ok)
        return { outcome: "invalid", code: resolved.code };
    if (target.isSymbolicLink) {
        return { outcome: "denied", code: "symbolic_link" };
    }
    if (target.isDirectory) {
        return { outcome: "denied", code: "directory_target" };
    }
    const sensitiveReason = classifySensitiveRead({
        absolutePath: supplied.value.absolutePath,
        isDirectory: false,
    }) ??
        classifySensitiveRead({
            absolutePath: resolved.value.absolutePath,
            isDirectory: false,
        });
    if (sensitiveReason !== null) {
        return approvalRequired(target, sensitiveReason);
    }
    if (!supplied.value.withinWorkspace || !resolved.value.withinWorkspace) {
        return approvalRequired(target, "outside_workspace");
    }
    return {
        outcome: "allowed",
        requestedPath: supplied.value.absolutePath,
        resolvedPath: resolved.value.absolutePath,
    };
}
function approvalRequired(target, reason) {
    return {
        outcome: "approval_required",
        requestedPath: target.requestedPath,
        resolvedPath: target.resolvedPath,
        reason,
        disclosureWarning: reason === "outside_workspace"
            ? "The resolved target is outside the selected workspace. Its contents may enter model context."
            : "The requested or resolved target is sensitive or protected. Its contents may enter model context.",
    };
}
