import path from "node:path";
import {
  createGuidanceLoader,
  type GuidanceBlock,
  renderGuidanceBlock,
} from "../adapters/windows/guidance-loader.ts";
import type { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.ts";
import type { ProviderConfig } from "../domain/config/provider-config.ts";
import { computeContextBudget, conservativeEstimate } from "../domain/context/context-budget.ts";
import { availableTools, COORDINATOR_TOOL_NAMES } from "../domain/tool-catalog/tool-catalog.ts";
import type { ProviderConversationItem } from "../ports/model-provider.ts";
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
      /** Skill catalog state, for the launch summary. */
      skills: SkillsSummary;
      /** Rebuilt history, for the launch summary. */
      prior: PriorSummary;
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
  /**
   * Enable the workspace document Skill catalog. Off by default: the confirmed
   * design gives each Session its own switch, and enabling it grants no read
   * permission beyond ordinary file access.
   */
  enableSkills?: boolean;
  /**
   * Enable process execution: shell and the background task tools. Off by default.
   * Every command still requires its own one-shot approval, and an approved command
   * runs with the current Windows user's full permissions — v1 has no OS sandbox.
   */
  enableProcesses?: boolean;
  /**
   * Conversation identity. A fresh launch supplies a new ID; explicit resume
   * and configuration reload reuse one. Absent creates one per coordinator.
   */
  sessionId?: string;
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
  const enableProcesses = options.enableProcesses === true;
  const tools = createWorkspaceTools({
    workspaceRoot: options.workspaceRoot,
    // This gate answers inline requests that do not go through the suspend path,
    // such as a sensitive read_file. There is no interactive channel attached to
    // it, so it denies. Mutating tools require approval and therefore suspend
    // instead, reaching the TUI.
    approvals: { decide: async () => "denied" },
    ids: { create: () => "probe" },
    enableWrites,
    enableProcesses,
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

  // Skills are off unless the Session opts in, matching the confirmed design.
  // Enabling the switch is not permission to read anything sensitive; the catalog
  // is untrusted metadata and bodies are read through ordinary read_file.
  const skills = await loadSkills(options.workspaceRoot, options.enableSkills === true);

  if (!assembly.ok) {
    return {
      kind: "demo",
      coordinator: createDemoRuntime(options.workspaceRoot).coordinator,
      reason: assembly.code,
      ...(assembly.detail === undefined ? {} : { detail: assembly.detail }),
    };
  }

  // One sourced block holds guidance and the skill catalog, guidance first so a
  // skill description cannot appear to override project rules.
  const contextBlock = [guidance.block, skills.block].filter((part) => part !== "").join("\n\n");

  const { RuntimeCoordinator } = await import("../application/coordinator/runtime-coordinator.ts");
  const { JsonlEventLog } = await import("../adapters/persistence/jsonl-event-log.ts");
  const { JsonlCheckpointStore } = await import(
    "../adapters/persistence/jsonl-checkpoint-store.ts"
  );

  const ids = { create: () => crypto.randomUUID() };
  const digests = {
    async sha256Canonical(value: unknown): Promise<string> {
      const data = new TextEncoder().encode(JSON.stringify(value));
      const hash = await crypto.subtle.digest("SHA-256", data);
      return Buffer.from(hash).toString("hex");
    },
  };

  // Durable Session log. Without it every launch starts with no history, which
  // makes the product unusable for anything spanning more than one sitting.
  const sessionRoot = path.join(options.dataDirectory, "sessions");
  const eventLog = new JsonlEventLog(sessionRoot, ids, digests);
  const checkpoints = new JsonlCheckpointStore(sessionRoot, digests);

  // Rebuild prior conversation so a resumed Session continues with its history.
  // A rebuild failure is reported and the Run starts fresh rather than guessing at
  // a repaired history.
  const prior = await rebuildPriorConversation(eventLog, options.sessionId);

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
        enableProcesses,
      }),
      approvals: { decide: async () => "denied" },
      eventLog,
      checkpoints,
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(prior.conversation.length === 0 ? {} : { priorConversation: prior.conversation }),
      ...(contextBlock === "" ? {} : { projectContext: contextBlock }),
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
    prior: prior.summary,
    skills: skills.summary,
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
      ...(selection.skills.kind === "loaded"
        ? [`skills: ${selection.skills.count} catalogued (~${selection.skills.tokens} tokens)`]
        : selection.skills.kind === "failed"
          ? [`skills: not loaded (${selection.skills.code})`]
          : selection.skills.kind === "disabled"
            ? ["skills: disabled"]
            : ["skills: none"]),
      ...(selection.prior.kind === "rebuilt"
        ? [`history: ${selection.prior.runs} run(s), ${selection.prior.items} item(s)`]
        : selection.prior.kind === "failed"
          ? [`history: not rebuilt (${selection.prior.code})`]
          : ["history: none"]),
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

export type PriorSummary =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "rebuilt"; runs: number; items: number }>
  | Readonly<{ kind: "failed"; code: string }>;

/**
 * Rebuild the conversation from a Session's stored events.
 *
 * A failed rebuild is reported rather than hidden: silently starting fresh would
 * make a damaged history look like a new Session.
 */
async function rebuildPriorConversation(
  eventLog: InstanceType<typeof import("../adapters/persistence/jsonl-event-log.ts").JsonlEventLog>,
  sessionId: string | undefined,
): Promise<Readonly<{ conversation: readonly ProviderConversationItem[]; summary: PriorSummary }>> {
  if (sessionId === undefined) {
    return { conversation: [], summary: { kind: "none" } };
  }
  try {
    const stored = await eventLog.readWithRecovery(sessionId);
    if (!stored.ok) {
      return { conversation: [], summary: { kind: "failed", code: stored.code } };
    }
    const { rebuildConversation, trimConversation } = await import(
      "../application/coordinator/conversation-rebuild.ts"
    );
    const rebuilt = rebuildConversation(stored.events);
    if (!rebuilt.ok) {
      return { conversation: [], summary: { kind: "failed", code: rebuilt.code } };
    }
    if (rebuilt.conversation.length === 0) {
      return { conversation: [], summary: { kind: "none" } };
    }
    // Bound the rebuilt history so a long Session does not consume the whole
    // context before the new task is even considered.
    const trimmed = trimConversation(rebuilt.conversation, 40);
    return {
      conversation: trimmed,
      summary: { kind: "rebuilt", runs: rebuilt.runs, items: trimmed.length },
    };
  } catch {
    return { conversation: [], summary: { kind: "failed", code: "rebuild_failed" } };
  }
}

export type SkillsSummary =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loaded"; count: number; tokens: number }>
  | Readonly<{ kind: "failed"; code: string }>;

/**
 * Load the Skill catalog when the Session enabled it.
 *
 * A discovery failure is reported rather than hidden: a broken SKILL.md would
 * otherwise look like a skill that simply is not there.
 */
async function loadSkills(
  workspaceRoot: string,
  enabled: boolean,
): Promise<Readonly<{ block: string; summary: SkillsSummary }>> {
  if (!enabled) return { block: "", summary: { kind: "disabled" } };
  const { createSkillDiscovery } = await import("../adapters/windows/skill-discovery.ts");
  const discovery = createSkillDiscovery({ workspaceRoot });
  const result = await discovery.discover({ enabled: true });
  if (!result.ok) {
    if (result.code === "not_found") return { block: "", summary: { kind: "none" } };
    return { block: "", summary: { kind: "failed", code: result.code } };
  }
  if (result.catalog.skills.length === 0) {
    return { block: "", summary: { kind: "none" } };
  }
  return {
    block: result.block,
    summary: {
      kind: "loaded",
      count: result.catalog.skills.length,
      tokens: result.catalog.estimatedTokens,
    },
  };
}
