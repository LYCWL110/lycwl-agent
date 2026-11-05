import {
  createGuidanceLoader,
  type GuidanceBlock,
  renderGuidanceBlock,
} from "../adapters/windows/guidance-loader.ts";
import type { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.ts";
import type { ProviderConfig } from "../domain/config/provider-config.ts";
import { computeContextBudget, conservativeEstimate } from "../domain/context/context-budget.ts";
import { availableTools, COORDINATOR_TOOL_NAMES } from "../domain/tool-catalog/tool-catalog.ts";
import { createDemoRuntime } from "./demo-runtime.ts";
import { createWorkspaceTools } from "./read-only-tools.ts";
import { assembleRuntime, type RuntimeAssemblyFailure } from "./runtime-assembly.ts";

/**
 * Choose and build the runtime for a launch.
 *
 * Kept separate from the entry point so the selection rule is testable without a
 * terminal, a network or a real credential.
 *
 * The rule that matters: a saved Provider configuration is authoritative. If it
 * exists and cannot be assembled, the caller is told why. Falling back to the demo
 * is allowed so the interface still opens, but it is never silent, because a demo
 * that looks like a working agent is the most misleading possible outcome.
 */

export type RuntimeSelection =
  | Readonly<{
      kind: "real";
      coordinator: RuntimeCoordinator;
      config: ProviderConfig;
      /** Whether filesystem mutation tools are exposed for this session. */
      enableWrites: boolean;
      /** Project guidance that was injected, for the launch summary. */
      guidance: GuidanceSummary;
      warnings: readonly string[];
    }>
  | Readonly<{
      kind: "demo";
      coordinator: RuntimeCoordinator;
      reason: "no_configuration" | RuntimeAssemblyFailure;
      detail?: string;
    }>;

export type SelectRuntimeOptions = Readonly<{
  workspaceRoot: string;
  dataDirectory: string;
  settings: unknown;
  /** True when a settings document exists at all. */
  hasSettings: boolean;
  /**
   * Enable filesystem mutation tools. Off by default so a session cannot write
   * unless the caller explicitly opts in; every write still requires one-shot
   * approval through the coordinator's suspend path.
   */
  enableWrites?: boolean;
  post?: Parameters<typeof assembleRuntime>[0]["post"];
  trustedCaPem?: string;
}>;

export async function selectRuntime(options: SelectRuntimeOptions): Promise<RuntimeSelection> {
  if (!options.hasSettings) {
    return {
      kind: "demo",
      coordinator: createDemoRuntime(options.workspaceRoot).coordinator,
      reason: "no_configuration",
    };
  }

  const enableWrites = options.enableWrites === true;
  const tools = createWorkspaceTools({
    workspaceRoot: options.workspaceRoot,
    // This gate answers inline requests that do not go through the suspend path,
    // such as a sensitive read_file. There is no interactive channel attached to
    // it, so it denies. Mutating tools require approval and therefore suspend
    // instead, reaching the TUI.
    approvals: { decide: async () => "denied" },
    ids: { create: () => "probe" },
    enableWrites,
    enableProcesses: false,
  });

  // Advertise only tools this composition actually exposes under the current
  // flags, so the model never sees a schema for something that would fail at call
  // time with tool_unavailable_in_build. `ask_user` is answered by the coordinator
  // rather than a tool executor, so it has no definition and is always available.
  const catalog = availableTools(
    (name) => name === COORDINATOR_TOOL_NAMES.ask_user || tools.getDefinition(name) !== null,
  );
  const toolDefinitions = catalog.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema as unknown as Readonly<Record<string, unknown>>,
  }));

  const assembly = await assembleRuntime({
    settings: options.settings,
    dataDirectory: options.dataDirectory,
    toolDefinitions,
    ...(options.post === undefined ? {} : { post: options.post }),
    ...(options.trustedCaPem === undefined ? {} : { trustedCaPem: options.trustedCaPem }),
  });

  // Project guidance is loaded once at Run setup and injected as sourced,
  // untrusted material before the task. A load failure is reported and guidance is
  // omitted rather than silently dropping a project rule.
  const guidance = await loadGuidance(options.workspaceRoot);

  if (!assembly.ok) {
    return {
      kind: "demo",
      coordinator: createDemoRuntime(options.workspaceRoot).coordinator,
      reason: assembly.code,
      ...(assembly.detail === undefined ? {} : { detail: assembly.detail }),
    };
  }

  const { RuntimeCoordinator } = await import("../application/coordinator/runtime-coordinator.ts");
  const { InMemoryEventLog } = await import("../application/coordinator/event-log.ts");

  // Compute the C04 budget only from a verified window. A capacity failure leaves
  // budgeting off rather than substituting a guess.
  const computed = computeContextBudget({
    window: assembly.config.contextWindow,
    modelMaxOutput: assembly.config.maxOutputTokens,
    userMaxOutput: assembly.config.maxOutputTokens,
    // The fixed part is the guidance block plus the tool schemas; both are sent
    // every request and are not reducible by summarisation.
    fixed: conservativeEstimate(estimateFixedTokens(guidance.block, toolDefinitions)),
  });
  const contextBudget = computed.ok ? computed.value : null;
  const budgetWarning =
    computed.ok || computed.code === "model_context_unknown"
      ? null
      : `context budgeting disabled (${computed.code})`;

  const ids = { create: () => crypto.randomUUID() };
  const digests = {
    async sha256Canonical(value: unknown): Promise<string> {
      const data = new TextEncoder().encode(JSON.stringify(value));
      const hash = await crypto.subtle.digest("SHA-256", data);
      return Buffer.from(hash).toString("hex");
    },
  };

  return {
    kind: "real",
    config: assembly.config,
    enableWrites,
    warnings: budgetWarning === null ? assembly.warnings : [...assembly.warnings, budgetWarning],
    coordinator: new RuntimeCoordinator({
      provider: assembly.provider,
      tools: createWorkspaceTools({
        workspaceRoot: options.workspaceRoot,
        // No interactive channel is attached to this gate, so it denies. Tools
        // that require approval still suspend and reach the TUI.
        approvals: { decide: async () => "denied" },
        ids,
        enableWrites,
        enableProcesses: false,
      }),
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
      ...(guidance.block === "" ? {} : { projectContext: guidance.block }),
      // Budgeting applies only when a verified window was configured. Without one,
      // no compaction runs and an oversized prompt fails at the provider instead of
      // being silently truncated.
      ...(contextBudget === null ? {} : { contextBudget }),
      // Scoped refresh: when the Run touches a new path, gap the loader up to that
      // directory so a subdirectory AGENTS.md is injected too.
      resolveProjectGuidance: async (touched) => {
        const loader = createGuidanceLoader({ workspaceRoot: options.workspaceRoot });
        const seen = new Set<string>();
        const blocks: GuidanceBlock[] = [];
        for (const entry of touched) {
          const loaded = await loader.load({
            targetPath: entry.path,
            targetIsDirectory: entry.isDirectory,
          });
          if (!loaded.ok) continue;
          for (const block of loaded.blocks) {
            if (seen.has(block.path)) continue;
            seen.add(block.path);
            blocks.push(block);
          }
        }
        if (blocks.length === 0) return null;
        return {
          text: renderGuidanceBlock(blocks),
          sources: blocks.map((block) => block.path),
        };
      },
    }),
    guidance: guidance.summary,
  };
}

/** Human-readable launch summary, printed before the TUI takes the screen. */
export function describeSelection(selection: RuntimeSelection): readonly string[] {
  if (selection.kind === "real") {
    return [
      `mode: real provider`,
      `model: ${selection.config.model}`,
      `endpoint: ${selection.config.baseUrl}`,
      `writes: ${selection.enableWrites ? "enabled (every write requires approval)" : "disabled"}`,
      ...(selection.guidance.kind === "loaded"
        ? [
            `guidance: ${selection.guidance.files.length} file(s), ${selection.guidance.bytes} bytes`,
          ]
        : selection.guidance.kind === "failed"
          ? [`guidance: not loaded (${selection.guidance.code})`]
          : ["guidance: none"]),
      ...selection.warnings.map((warning) => `warning: ${warning}`),
    ];
  }
  if (selection.reason === "no_configuration") {
    return [
      "mode: demo runtime",
      "reason: no Provider is configured",
      "the demo performs no network, credential, process or write access",
    ];
  }
  return [
    "mode: demo runtime",
    `reason: the saved Provider configuration is unusable (${selection.reason}${selection.detail === undefined ? "" : `: ${selection.detail}`})`,
    "run lycwl --setup to inspect the configuration",
  ];
}

export type GuidanceSummary =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loaded"; files: readonly string[]; bytes: number }>
  | Readonly<{ kind: "failed"; code: string }>;

/**
 * Load project guidance for the workspace root.
 *
 * The target is the workspace root itself, so discovery covers the root and any
 * intermediate directories on the path to it, which is the correct scope for a
 * session that has not yet read a specific file.
 */
async function loadGuidance(
  workspaceRoot: string,
): Promise<Readonly<{ block: string; summary: GuidanceSummary }>> {
  const loader = createGuidanceLoader({ workspaceRoot });
  const loaded = await loader.load({ targetPath: workspaceRoot, targetIsDirectory: true });
  if (!loaded.ok) {
    return { block: "", summary: { kind: "failed", code: loaded.code } };
  }
  if (loaded.blocks.length === 0) {
    return { block: "", summary: { kind: "none" } };
  }
  return {
    block: renderGuidanceBlock(loaded.blocks),
    summary: {
      kind: "loaded",
      files: loaded.blocks.map((b) => b.path),
      bytes: loaded.totalBytes,
    },
  };
}

/** Estimated tokens of the parts sent on every request and never summarised. */
function estimateFixedTokens(
  guidanceBlock: string,
  tools: readonly Readonly<{ description: string }>[],
): number {
  let total = Math.ceil(guidanceBlock.length / 4);
  for (const tool of tools) total += Math.ceil(tool.description.length / 4) + 50;
  return total;
}
