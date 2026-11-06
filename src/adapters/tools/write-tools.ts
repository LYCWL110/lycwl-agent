import { createHash } from "node:crypto";

import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";
import {
  type CreateFilePlan,
  type EditFilePlan,
  type LineEndingChoice,
  planCreateFile,
  planEditFile,
} from "../../services/files/file-write.ts";
import type { TextFileEncoding } from "../../services/files/text-snapshot.ts";

export type WriteTargetFacts = Readonly<{
  /** SHA-256 of the current bytes, or null when the file does not exist. */
  sha256: string | null;
  exists: boolean;
  stateKey?: string;
}>;

export type WriteToolDependencies = Readonly<{
  approvals: ApprovalGate;
  /** Injected, side-effect-free facts for the exact target. */
  inspectTarget: (path: string) => Promise<WriteTargetFacts>;
  /** Injected read for edit_file; a real adapter is Stage 2. */
  readBytes: (path: string) => Promise<Uint8Array>;
  /**
   * Injected write sink. Called only after approval and precondition recheck.
   * A real adapter must use same-volume temp + replace and G06 checks.
   */
  writeBytes: (path: string, bytes: Uint8Array, expected?: WriteTargetFacts) => Promise<void>;
}>;

export const CREATE_FILE_DEFINITION: ToolDefinition = {
  name: "create_file",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  requiresApproval: true,
  concurrencySafe: false,
};

export const EDIT_FILE_DEFINITION: ToolDefinition = {
  name: "edit_file",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  requiresApproval: true,
  concurrencySafe: false,
};

const DEFINITIONS: readonly ToolDefinition[] = [CREATE_FILE_DEFINITION, EDIT_FILE_DEFINITION];
/** Codes that prove the sink refused before any byte was written. */
const KNOWN_PRE_WRITE_CODES: ReadonlySet<string> = new Set([
  "invalid_path",
  "file_conflict",
  "access_denied",
  "not_found",
  "locked",
]);

export function createWriteTools(dependencies: WriteToolDependencies): ToolExecutor {
  const prepared = new Map<string, { args: string; plan: PlannedWrite }>();
  const refused = new Map<string, { args: string; code: string }>();
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
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
      if (saved.args !== JSON.stringify(request.arguments)) return false;
      const current = await dependencies.inspectTarget(saved.plan.path);
      return sameTargetState(current, saved.plan.expectedBefore);
    },
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const saved = prepared.get(request.toolCallId);
      const refusal = refused.get(request.toolCallId);
      prepared.delete(request.toolCallId);
      refused.delete(request.toolCallId);
      if (refusal !== undefined) return { status: "failed", safeCode: refusal.code, text: null };
      if (request.approvalGranted && saved === undefined)
        return { status: "failed", safeCode: "approval_precondition_missing", text: null };
      if (request.signal?.aborted)
        return { status: "failed", safeCode: "tool_cancelled", text: null };
      if (saved !== undefined && saved.args !== JSON.stringify(request.arguments)) {
        return { status: "failed", safeCode: "file_conflict", text: null };
      }
      const planned =
        saved === undefined
          ? await planFor(dependencies, request)
          : { ok: true as const, value: saved.plan };
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
      } catch (error) {
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

type PlannedWrite = Readonly<{
  path: string;
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
  expectedBefore: WriteTargetFacts;
  summary: Readonly<Record<string, string | number | boolean>>;
}>;

type PlanResult =
  | Readonly<{ ok: true; value: PlannedWrite }>
  | Readonly<{ ok: false; code: string }>;

async function planFor(
  dependencies: WriteToolDependencies,
  request: ToolExecutionRequest,
): Promise<PlanResult> {
  if (request.toolName === CREATE_FILE_DEFINITION.name) {
    return planCreate(dependencies, request.arguments);
  }
  if (request.toolName === EDIT_FILE_DEFINITION.name) {
    return planEdit(dependencies, request.arguments);
  }
  return { ok: false, code: "unknown_tool" };
}

async function planCreate(dependencies: WriteToolDependencies, args: unknown): Promise<PlanResult> {
  if (typeof args !== "object" || args === null) return { ok: false, code: "invalid_arguments" };
  const record = args as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  const content = record["content"];
  if (typeof content !== "string") return { ok: false, code: "invalid_arguments" };

  const encoding = record["encoding"];
  const lineEnding = record["lineEnding"];
  const plan = planCreateFile({
    content,
    ...(encoding === undefined ? {} : { encoding: encoding as TextFileEncoding }),
    ...(lineEnding === undefined
      ? {}
      : { lineEnding: lineEnding as LineEndingChoice | "preserve" }),
  });
  if (!plan.ok) return { ok: false, code: plan.code };

  const target = await dependencies.inspectTarget(path);
  // create_file never overwrites an existing target.
  if (target.exists) return { ok: false, code: "file_conflict" };

  const value: CreateFilePlan = plan.value;
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

async function planEdit(dependencies: WriteToolDependencies, args: unknown): Promise<PlanResult> {
  if (typeof args !== "object" || args === null) return { ok: false, code: "invalid_arguments" };
  const record = args as Record<string, unknown>;
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
  if (!target.exists) return { ok: false, code: "not_found" };

  const originalBytes = await dependencies.readBytes(path);
  const originalSha = createHash("sha256").update(originalBytes).digest("hex");
  if (target.sha256 !== null && target.sha256 !== originalSha) {
    return { ok: false, code: "file_conflict" };
  }

  const declared = detectFormat(originalBytes);
  const plan = planEditFile({
    originalBytes,
    encoding: (record["encoding"] as TextFileEncoding | undefined) ?? declared.encoding,
    bom: record["bom"] === true || declared.bom,
    lineEnding: declared.lineEnding,
    oldText,
    newText,
    replaceAll: record["replaceAll"] === true,
    ...(record["expectedOccurrences"] === undefined
      ? {}
      : { expectedOccurrences: record["expectedOccurrences"] as number }),
    ...(record["insertedLineEnding"] === undefined
      ? {}
      : { insertedLineEnding: record["insertedLineEnding"] as LineEndingChoice }),
  });
  if (!plan.ok) return { ok: false, code: plan.code };

  const value: EditFilePlan = plan.value;
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

function detectFormat(bytes: Uint8Array): {
  encoding: TextFileEncoding;
  bom: boolean;
  lineEnding: "none" | "lf" | "crlf" | "cr" | "mixed";
} {
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasUtf16Le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasUtf16Be = bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding: TextFileEncoding = hasUtf16Le ? "utf-16le" : hasUtf16Be ? "utf-16be" : "utf-8";
  const body = bytes.subarray(hasUtf8Bom ? 3 : hasUtf16Le || hasUtf16Be ? 2 : 0);
  const text = Buffer.from(body).toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  const lineEnding =
    kinds === 0 ? "none" : kinds > 1 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "cr";
  return { encoding, bom: hasUtf8Bom || hasUtf16Le || hasUtf16Be, lineEnding };
}

function sameTargetState(left: WriteTargetFacts, right: WriteTargetFacts): boolean {
  return (
    left.exists === right.exists && left.sha256 === right.sha256 && left.stateKey === right.stateKey
  );
}

function renderPreview(toolName: string, plan: PlannedWrite): string {
  return [
    toolName,
    ...Object.entries(plan.summary).map(([key, value]) => `${key}=${String(value)}`),
    "effect=replaces file bytes on disk",
  ].join("\n");
}

function renderResult(plan: PlannedWrite): string {
  return [
    `${String(plan.summary["operation"])}: ${plan.path}`,
    `bytes=${plan.byteLength}`,
    `sha256=${plan.sha256}`,
    ...Object.entries(plan.summary)
      .filter(([key]) => key !== "operation" && key !== "path" && key !== "bytes")
      .map(([key, value]) => `${key}=${String(value)}`),
  ].join("\n");
}
