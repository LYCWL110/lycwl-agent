import { createBackgroundTools } from "../adapters/tools/background-tools.ts";
import { createLspTools } from "../adapters/tools/lsp-tools.ts";
import { createMutationTools } from "../adapters/tools/mutation-tools.ts";
import { createApplyPatchTool } from "../adapters/tools/patch-tool.ts";
import { createReadFileTool } from "../adapters/tools/read-file-tool.ts";
import { createSearchTools, type SearchEntry } from "../adapters/tools/search-tools.ts";
import { createShellTool } from "../adapters/tools/shell-tool.ts";
import { createWriteTools } from "../adapters/tools/write-tools.ts";
import { createBackgroundRegistry } from "../adapters/windows/background-registry.ts";
import { createLspRegistry } from "../adapters/windows/lsp-registry.ts";
import { createProcessSupervisor } from "../adapters/windows/process-supervisor.ts";
import { createWindowsFileReader } from "../adapters/windows/windows-directory-reader.ts";
import { createWindowsFsAdapter } from "../adapters/windows/windows-fs-adapter.ts";
import { createWindowsMutationAdapter } from "../adapters/windows/windows-mutation-adapter.ts";
import { createWindowsWriteAdapter } from "../adapters/windows/windows-write-adapter.ts";
import type { ApprovalGate } from "../ports/approval-gate.ts";
import type { IdentifierFactory } from "../ports/identity.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../ports/tool-executor.ts";

/**
 * Composition root for the delivered filesystem slices.
 *
 * Read-only tools (Stage 2A) and write tools (Stage 2B) are wired to real disk.
 * Every other tool name fails closed with `tool_unavailable_in_build`, so a model
 * can never reach a process, network, credential, LSP, delete or rename path.
 */
export const UNAVAILABLE_CODE = "tool_unavailable_in_build";

export type WorkspaceToolsOptions = Readonly<{
  workspaceRoot: string;
  approvals: ApprovalGate;
  ids: IdentifierFactory;
  /** Set false to keep the build read-only even where writes are implemented. */
  enableWrites?: boolean;
  /**
   * Set true only where G02 supervision has been validated on this host. When
   * false, `shell` and the background tools stay unavailable.
   */
  enableProcesses?: boolean;
  /**
   * Set true only where LSP supervision has been validated. A language server
   * must also be started explicitly with an approved instance; enabling this flag
   * alone exposes the tools and does not spawn anything.
   */
  enableLsp?: boolean;
}>;

export function createReadOnlyWorkspaceTools(options: WorkspaceToolsOptions): ToolExecutor {
  return createWorkspaceTools({ ...options, enableWrites: false, enableProcesses: false });
}

export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolExecutor {
  const { workspaceRoot, approvals, ids } = options;
  const enableWrites = options.enableWrites !== false;
  const enableProcesses = options.enableProcesses === true;
  const enableLsp = options.enableLsp === true;
  const lspRegistry = createLspRegistry({
    inheritedEnvironment: { ...process.env } as Record<string, string>,
  });

  const fsAdapter = createWindowsFsAdapter({ workspaceRoot });
  const reader = createWindowsFileReader({ workspaceRoot });
  const writer = createWindowsWriteAdapter({ workspaceRoot });
  const mutator = createWindowsMutationAdapter({ workspaceRoot });

  const readFile = createReadFileTool({
    workspaceRoot,
    approvals,
    ids,
    inspectTarget: async (requestedPath) => {
      const inspected = await fsAdapter.inspect(requestedPath);
      if (!inspected.ok) throw new Error(inspected.code);
      return { snapshot: inspected.snapshot, target: { ...inspected.target, requestedPath } };
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
    readText: async (filePath) => {
      const text = await reader.readText(filePath);
      if (text === null) throw new Error("read_failed");
      return text;
    },
  });

  const writes = enableWrites
    ? createWriteTools({
        approvals,
        inspectTarget: async (requestedPath) => {
          try {
            return await writer.inspectTarget(requestedPath);
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : "invalid_path");
          }
        },
        readBytes: async (requestedPath) => writer.readBytes(requestedPath),
        writeBytes: async (requestedPath, bytes) => {
          const result = await writer.writeBytes(requestedPath, bytes);
          if (!result.ok) throw new Error(result.code);
        },
      })
    : null;

  const patch = enableWrites
    ? createApplyPatchTool({
        inspectTargets: async (paths) => {
          const snapshots = [];
          for (const candidate of paths) {
            snapshots.push(await writer.inspectPatchTarget(candidate));
          }
          return snapshots;
        },
        writeBytes: async (requestedPath, bytes) => {
          const result = await writer.writeBytes(requestedPath, bytes);
          if (!result.ok) throw new Error(result.code);
        },
      })
    : null;

  const mutations = enableWrites
    ? createMutationTools({
        inspectDeleteTargets: async (paths) => mutator.inspectDeleteTargets(paths),
        inspectRename: async (from, to) => mutator.inspectRename(from, to),
        deletePath: async (target) => mutator.deletePath(target),
        renamePath: async (from, to) => mutator.renamePath(from, to),
      })
    : null;

  const processes = enableProcesses
    ? createShellTool({
        sessionMode: enableWrites ? "workspace_write" : "read_only",
        inheritedEnvironment: { ...process.env } as Record<string, string>,
        runShell: async (request) => {
          const supervisor = createProcessSupervisor();
          const outcome = await supervisor.runToCompletion({
            command: request.command,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
          });
          if (outcome.kind === "failed") {
            return { kind: "unknown", safeCode: outcome.code };
          }
          return outcome.timedOut
            ? { kind: "timed_out", stdout: outcome.stdout, stderr: outcome.stderr }
            : {
                kind: "completed",
                exitCode: outcome.exitCode,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
              };
        },
      })
    : null;

  const background = enableProcesses
    ? createBackgroundTools(
        createBackgroundRegistry({
          sessionMode: enableWrites ? "workspace_write" : "read_only",
          inheritedEnvironment: { ...process.env } as Record<string, string>,
        }).dependencies,
      )
    : null;

  const delegates: ToolExecutor[] = [readFile, search];
  if (writes !== null) delegates.push(writes);
  if (patch !== null) delegates.push(patch);
  if (mutations !== null) delegates.push(mutations);
  if (processes !== null) delegates.push(processes);
  if (background !== null) delegates.push(background);
  if (enableLsp === true) {
    delegates.push(createLspTools(lspRegistry.dependencies));
  }

  function resolveDelegate(toolName: string): ToolExecutor | null {
    for (const delegate of delegates) {
      if (delegate.getDefinition(toolName) !== null) return delegate;
    }
    return null;
  }

  return {
    getDefinition(toolName: string): ToolDefinition | null {
      for (const delegate of delegates) {
        const definition = delegate.getDefinition(toolName);
        if (definition !== null) return definition;
      }
      return null;
    },

    async preview(request: ToolExecutionRequest) {
      const delegate = resolveDelegate(request.toolName);
      return delegate?.preview === undefined ? null : delegate.preview(request);
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const delegate = resolveDelegate(request.toolName);
      if (delegate === null) {
        return { status: "failed", safeCode: UNAVAILABLE_CODE, text: null };
      }
      try {
        return await delegate.execute(request);
      } catch (error) {
        const safeCode = error instanceof Error ? error.message : "read_failed";
        return { status: "failed", safeCode, text: null };
      }
    },
  };
}
