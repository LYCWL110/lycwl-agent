import { createReadFileTool } from "../adapters/tools/read-file-tool.ts";
import type { SearchEntry } from "../adapters/tools/search-tools.ts";
import { createSearchTools } from "../adapters/tools/search-tools.ts";
import { createWindowsFileReader } from "../adapters/windows/windows-directory-reader.ts";
import { createWindowsFsAdapter } from "../adapters/windows/windows-fs-adapter.ts";
import type { ApprovalGate } from "../ports/approval-gate.ts";
import type { IdentifierFactory } from "../ports/identity.ts";
import type { ToolDefinition, ToolExecutionResult, ToolExecutor } from "../ports/tool-executor.ts";

/**
 * Composition root for the Stage 2A read-only filesystem slice.
 *
 * Only read_file, list_dir, glob and grep are wired to real disk. Every other
 * tool name fails closed with `tool_unavailable_in_build`, so a model can never
 * reach a write, process, network, credential or LSP path in this build.
 */
export const UNAVAILABLE_CODE = "tool_unavailable_in_build";

export type ReadOnlyToolsOptions = Readonly<{
  workspaceRoot: string;
  approvals: ApprovalGate;
  ids: IdentifierFactory;
}>;

export function createReadOnlyWorkspaceTools(options: ReadOnlyToolsOptions): ToolExecutor {
  const { workspaceRoot, approvals, ids } = options;
  const fsAdapter = createWindowsFsAdapter({ workspaceRoot });
  const reader = createWindowsFileReader({ workspaceRoot });

  const readFile = createReadFileTool({
    workspaceRoot,
    approvals,
    ids,
    inspectTarget: async (requestedPath) => {
      const inspected = await fsAdapter.inspect(requestedPath);
      if (!inspected.ok) throw new Error(inspected.code);
      // Keep the caller's requested path: the flow compares it against the
      // invocation it was given, while the resolved target identity stays from
      // the adapter.
      return {
        snapshot: inspected.snapshot,
        target: { ...inspected.target, requestedPath },
      };
    },
    readBytes: async (requestedPath) => {
      const read = await reader.readFile(requestedPath);
      if (!read.ok) throw new Error(read.code);
      return read.bytes;
    },
  });

  const search = createSearchTools({
    listEntries: async (directory): Promise<readonly SearchEntry[]> => {
      const listed = await reader.listDirectory(directory);
      if (!listed.ok) throw new Error(listed.code);
      return listed.entries;
    },
    readText: async (path) => {
      const text = await reader.readText(path);
      if (text === null) throw new Error("read_failed");
      return text;
    },
  });

  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return readFile.getDefinition(toolName) ?? search.getDefinition(toolName);
    },

    async preview(request) {
      const delegate = readFile.getDefinition(request.toolName) !== null ? readFile : search;
      return delegate.preview === undefined ? null : delegate.preview(request);
    },

    async execute(request): Promise<ToolExecutionResult> {
      const delegate =
        readFile.getDefinition(request.toolName) !== null
          ? readFile
          : search.getDefinition(request.toolName) !== null
            ? search
            : null;
      if (delegate === null) {
        return { status: "failed", safeCode: UNAVAILABLE_CODE, text: null };
      }
      try {
        return await delegate.execute(request);
      } catch (error) {
        // Adapter failures surface as safe codes, never raw OS messages.
        const safeCode = error instanceof Error ? error.message : "read_failed";
        return { status: "failed", safeCode, text: null };
      }
    },
  };
}
