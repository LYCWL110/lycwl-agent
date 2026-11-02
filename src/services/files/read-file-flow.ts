import type { ApprovalGate } from "../../ports/approval-gate.ts";
import {
  decideResolvedReadPermission,
  type ResolvedReadTarget,
} from "../permission/resolved-read-policy.ts";
import {
  captureConsistentSnapshot,
  type FileSnapshotFacts,
  MAX_SNAPSHOT_BYTES,
} from "./consistent-snapshot.ts";
import { createReadFileFact, type ReadFileFact } from "./read-file-fact.ts";
import { boundTextSnapshotForModel } from "./text-delivery.ts";
import { readTextSnapshot, type TextFileEncoding } from "./text-snapshot.ts";

export type ReadFileFlowRequest = Readonly<{
  workspaceRoot: string;
  requestedPath: string;
  snapshotId: string;
  approvalId: string;
  toolCallId: string;
  startLine?: number;
  lineCount?: number;
  encoding?: TextFileEncoding;
}>;

export type ReadFileFlowDependencies = Readonly<{
  approvals: ApprovalGate;
  inspectTarget: () => Promise<ReadFileFlowTargetFacts>;
  readBytes: () => Promise<Uint8Array>;
}>;

export type ReadFileFlowTargetFacts = Readonly<{
  snapshot: FileSnapshotFacts;
  target: ResolvedReadTarget;
}>;

export type ReadFileFlowResult =
  | Readonly<{ ok: true; value: ReadFileFact }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_path"
        | "directory_target"
        | "symbolic_link"
        | "approval_denied"
        | "precondition_changed"
        | "file_too_large"
        | "not_a_regular_file"
        | "file_changed"
        | "read_failed"
        | "decoding_failed"
        | "encoding_mismatch"
        | "binary_content"
        | "invalid_line_range";
    }>;

export async function runReadFileFlow(
  request: ReadFileFlowRequest,
  dependencies: ReadFileFlowDependencies,
): Promise<ReadFileFlowResult> {
  let inspected: ReadFileFlowTargetFacts;
  try {
    inspected = await dependencies.inspectTarget();
  } catch {
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
  if (decision.outcome === "denied") return { ok: false, code: decision.code };
  if (inspected.snapshot.size > MAX_SNAPSHOT_BYTES) {
    return { ok: false, code: "file_too_large" };
  }

  if (decision.outcome === "approval_required") {
    const approval = await dependencies.approvals.decide({
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      toolName: "read_file",
      safePreview: createPreview(
        decision.requestedPath,
        decision.resolvedPath,
        inspected.snapshot,
        decision.disclosureWarning,
      ),
    });
    if (approval !== "approved") return { ok: false, code: "approval_denied" };

    let before: ReadFileFlowTargetFacts;
    try {
      before = await dependencies.inspectTarget();
    } catch {
      return { ok: false, code: "read_failed" };
    }
    const precondition = decideResolvedReadPermission(request.workspaceRoot, before.target);
    if (
      !sameDecision(decision, precondition) ||
      !sameResolvedTarget(before.target, inspected.target) ||
      !sameSnapshotFacts(before.snapshot, inspected.snapshot)
    ) {
      return { ok: false, code: "precondition_changed" };
    }
    inspected = before;
  }

  const snapshot = await captureConsistentSnapshot({
    before: inspected.snapshot,
    read: dependencies.readBytes,
    after: async () => (await dependencies.inspectTarget()).snapshot,
  });
  if (!snapshot.ok) return { ok: false, code: snapshot.code };

  const text = readTextSnapshot(snapshot.value.bytes, {
    ...(request.startLine === undefined ? {} : { startLine: request.startLine }),
    ...(request.lineCount === undefined ? {} : { lineCount: request.lineCount }),
    ...(request.encoding === undefined ? {} : { encoding: request.encoding }),
  });
  if (!text.ok) return { ok: false, code: text.code };

  return {
    ok: true,
    value: createReadFileFact(request.snapshotId, boundTextSnapshotForModel(text.value)),
  };
}

export function sameDecision(
  left: ReturnType<typeof decideResolvedReadPermission>,
  right: ReturnType<typeof decideResolvedReadPermission>,
): boolean {
  if (left.outcome !== right.outcome) return false;
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

export function sameResolvedTarget(left: ResolvedReadTarget, right: ResolvedReadTarget): boolean {
  return (
    left.requestedPath.toLowerCase() === right.requestedPath.toLowerCase() &&
    left.resolvedPath.toLowerCase() === right.resolvedPath.toLowerCase() &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

export function sameSnapshotFacts(left: FileSnapshotFacts, right: FileSnapshotFacts): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.lastWriteTimeNs === right.lastWriteTimeNs &&
    left.isFile === right.isFile &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function sameRequestedPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function createPreview(
  requestedPath: string,
  resolvedPath: string,
  facts: FileSnapshotFacts,
  warning: string,
): string {
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
