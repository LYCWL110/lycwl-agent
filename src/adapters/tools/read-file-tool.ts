import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";
import {
  type ReadFileFlowTargetFacts,
  runReadFileFlow,
} from "../../services/files/read-file-flow.ts";
import type { TextFileEncoding } from "../../services/files/text-snapshot.ts";

export type ReadFileToolRequest = Readonly<{
  path: string;
  startLine?: number;
  lineCount?: number;
  encoding?: TextFileEncoding;
}>;

export type ReadFileToolDependencies = Readonly<{
  workspaceRoot: string;
  approvals: ApprovalGate;
  ids: IdentifierFactory;
  /** Injected, side-effect-free target inspection; a real adapter is Stage 2. */
  inspectTarget: (requestedPath: string) => Promise<ReadFileFlowTargetFacts>;
  readBytes: (requestedPath: string) => Promise<Uint8Array>;
}>;

export const READ_FILE_DEFINITION: ToolDefinition = {
  name: "read_file",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export function createReadFileTool(dependencies: ReadFileToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return toolName === READ_FILE_DEFINITION.name ? READ_FILE_DEFINITION : null;
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const parsed = parseReadFileArguments(request.arguments);
      if (!parsed.ok) {
        return { status: "failed", safeCode: parsed.code, text: null };
      }

      const result = await runReadFileFlow(
        {
          workspaceRoot: dependencies.workspaceRoot,
          requestedPath: parsed.value.path,
          snapshotId: dependencies.ids.create(),
          approvalId: dependencies.ids.create(),
          toolCallId: request.toolCallId,
          ...(parsed.value.startLine === undefined ? {} : { startLine: parsed.value.startLine }),
          ...(parsed.value.lineCount === undefined ? {} : { lineCount: parsed.value.lineCount }),
          ...(parsed.value.encoding === undefined ? {} : { encoding: parsed.value.encoding }),
        },
        {
          approvals: dependencies.approvals,
          inspectTarget: async () => dependencies.inspectTarget(parsed.value.path),
          readBytes: async () => dependencies.readBytes(parsed.value.path),
        },
      );

      if (!result.ok) {
        return { status: "failed", safeCode: result.code, text: null };
      }

      const fact = result.value;
      if (fact.slice.kind === "empty") {
        return {
          status: "succeeded",
          text: `read_file: empty slice at line ${fact.slice.atLine}\n`,
        };
      }

      const header = [
        `read_file: lines ${fact.slice.startLine}-${fact.slice.endLine}`,
        `bytes [${fact.slice.byteRange.start},${fact.slice.byteRange.end})`,
        `sha256 ${fact.snapshot.fileSha256}`,
        `lineEndings ${fact.snapshot.lineEndings}`,
        fact.textTruncated ? "modelText truncated" : "modelText complete",
      ].join("; ");
      return { status: "succeeded", text: `${header}\n${fact.content}` };
    },
  };
}

type ParseFailure = Readonly<{ ok: false; code: string }>;
type ParseSuccess = Readonly<{ ok: true; value: ReadFileToolRequest }>;

const ENCODINGS: ReadonlySet<string> = new Set(["utf-8", "utf-16le", "utf-16be", "latin-1"]);

function parseReadFileArguments(input: unknown): ParseSuccess | ParseFailure {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "invalid_arguments" };
  }
  const record = input as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }

  const startLine = record["startLine"];
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || (startLine as number) < 1)) {
    return { ok: false, code: "invalid_line_range" };
  }
  const lineCount = record["lineCount"];
  if (lineCount !== undefined && (!Number.isSafeInteger(lineCount) || (lineCount as number) < 1)) {
    return { ok: false, code: "invalid_line_range" };
  }
  const encoding = record["encoding"];
  if (encoding !== undefined && (typeof encoding !== "string" || !ENCODINGS.has(encoding))) {
    return { ok: false, code: "invalid_arguments" };
  }

  return {
    ok: true,
    value: {
      path,
      ...(startLine === undefined ? {} : { startLine: startLine as number }),
      ...(lineCount === undefined ? {} : { lineCount: lineCount as number }),
      ...(encoding === undefined ? {} : { encoding: encoding as TextFileEncoding }),
    },
  };
}
