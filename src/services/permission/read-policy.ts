import {
  classifySensitiveRead,
  type ParsedWorkspacePath,
  resolveWorkspacePath,
  type SensitiveReadReason,
  type WorkspacePathFailure,
} from "./workspace-path.ts";

export type ReadPermissionDecision =
  | Readonly<{ outcome: "allowed"; value: ParsedWorkspacePath }>
  | Readonly<{
      outcome: "approval_required";
      value: ParsedWorkspacePath;
      reason: SensitiveReadReason | "outside_workspace";
      disclosureWarning: string;
    }>
  | Readonly<{ outcome: "invalid"; code: WorkspacePathFailure }>;

export function decideReadPermission(
  workspaceRoot: string,
  requestedPath: string,
): ReadPermissionDecision {
  const path = resolveWorkspacePath(workspaceRoot, requestedPath);
  if (!path.ok) return { outcome: "invalid", code: path.code };

  const sensitiveReason = classifySensitiveRead(path.value);
  if (sensitiveReason !== null) {
    return approvalRequired(path.value, sensitiveReason);
  }
  if (!path.value.withinWorkspace) {
    return approvalRequired(path.value, "outside_workspace");
  }
  return { outcome: "allowed", value: path.value };
}

function approvalRequired(
  value: ParsedWorkspacePath,
  reason: SensitiveReadReason | "outside_workspace",
): ReadPermissionDecision {
  return {
    outcome: "approval_required",
    value,
    reason,
    disclosureWarning:
      reason === "outside_workspace"
        ? "This path is outside the selected workspace. Its contents may enter model context."
        : "This path is sensitive or protected. Its contents may enter model context.",
  };
}
