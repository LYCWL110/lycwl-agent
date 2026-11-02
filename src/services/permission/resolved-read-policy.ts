import {
  classifySensitiveRead,
  resolveWorkspacePath,
  type SensitiveReadReason,
  type WorkspacePathFailure,
} from "./workspace-path.ts";

export type ResolvedReadTarget = Readonly<{
  requestedPath: string;
  resolvedPath: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}>;

export type ResolvedReadDecision =
  | Readonly<{
      outcome: "allowed";
      requestedPath: string;
      resolvedPath: string;
    }>
  | Readonly<{
      outcome: "approval_required";
      requestedPath: string;
      resolvedPath: string;
      reason: SensitiveReadReason | "outside_workspace";
      disclosureWarning: string;
    }>
  | Readonly<{
      outcome: "denied";
      code: "directory_target" | "symbolic_link";
    }>
  | Readonly<{ outcome: "invalid"; code: WorkspacePathFailure }>;

export function decideResolvedReadPermission(
  workspaceRoot: string,
  target: ResolvedReadTarget,
): ResolvedReadDecision {
  const supplied = resolveWorkspacePath(workspaceRoot, target.requestedPath);
  if (!supplied.ok) return { outcome: "invalid", code: supplied.code };
  const resolved = resolveWorkspacePath(workspaceRoot, target.resolvedPath);
  if (!resolved.ok) return { outcome: "invalid", code: resolved.code };

  if (target.isSymbolicLink) {
    return { outcome: "denied", code: "symbolic_link" };
  }
  if (target.isDirectory) {
    return { outcome: "denied", code: "directory_target" };
  }

  const sensitiveReason =
    classifySensitiveRead({
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

function approvalRequired(
  target: ResolvedReadTarget,
  reason: SensitiveReadReason | "outside_workspace",
): ResolvedReadDecision {
  return {
    outcome: "approval_required",
    requestedPath: target.requestedPath,
    resolvedPath: target.resolvedPath,
    reason,
    disclosureWarning:
      reason === "outside_workspace"
        ? "The resolved target is outside the selected workspace. Its contents may enter model context."
        : "The requested or resolved target is sensitive or protected. Its contents may enter model context.",
  };
}
