import path from "node:path";
import { createFileEvidenceStore } from "../adapters/persistence/file-evidence-store.ts";
import { createSnapshotStore } from "../adapters/persistence/snapshot-store.ts";
import { createSpillStore } from "../adapters/persistence/spill-store.ts";
import {
  createDiscoverToolsTool,
  DISCOVER_TOOLS_NAME,
  DISCOVERY_TOOL_DESCRIPTION,
  DISCOVERY_TOOL_SCHEMA,
} from "../adapters/tools/discover-tools.ts";
import { createMcpTools, mcpToolDefinitions } from "../adapters/tools/mcp-tools.ts";
import { createFormatterRunner } from "../adapters/windows/formatter-runner.ts";
import {
  createGuidanceLoader,
  type GuidanceBlock,
  renderGuidanceBlock,
} from "../adapters/windows/guidance-loader.ts";
import { createSkillLoader } from "../adapters/windows/skill-loader.ts";
import { createSyntaxChecker, defaultTscEntry } from "../adapters/windows/syntax-checker.ts";
import type { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.ts";
import { deriveTaskReport } from "../application/task-report/derive-task-report.ts";
import type { ProviderConfig } from "../domain/config/provider-config.ts";
import { computeContextBudget, conservativeEstimate } from "../domain/context/context-budget.ts";
import {
  type DiscoverableTool,
  renderServerCatalog,
  shouldDiscover,
} from "../domain/mcp/tool-discovery.ts";
import { filterChildEnvironment } from "../domain/process/shell.ts";
import type { OwnedKeyRegistry } from "../domain/security/owned-key-guard.ts";
import { availableTools, COORDINATOR_TOOL_NAMES } from "../domain/tool-catalog/tool-catalog.ts";
import type { ApprovalGate } from "../ports/approval-gate.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import type { ProviderConversationItem } from "../ports/model-provider.ts";
import type { SensitiveSource } from "../ports/sensitive-context.ts";
import { assertProtectedValue } from "../services/security/guarded-delivery.ts";
import { createDemoRuntime } from "./demo-runtime.ts";
import { startMcpServers } from "./mcp-startup.ts";
import { createWorkspaceTools } from "./read-only-tools.ts";
import { assembleRuntime, type RuntimeAssemblyFailure } from "./runtime-assembly.ts";
import { readMcpDeclarations } from "./terminal-approval.ts";
import { undoSessionChanges } from "./undo.ts";

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
      historyEvents: readonly InternalEvent[];
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
  /**
   * Approval channel for MCP server startup. Servers must be approved before the
   * TUI exists, so this cannot use the coordinator's suspend path. Absent means no
   * MCP server can start.
   */
  mcpApprovals?: ApprovalGate;
  /** Injected for tests. */
  spawnMcp?: typeof import("node:child_process").spawn;
}>;

export async function selectRuntime(options: SelectRuntimeOptions): Promise<RuntimeSelection> {
  if (!options.hasSettings) {
    return {
      kind: "demo",
      coordinator: createDemoRuntime(options.workspaceRoot, options.sessionId).coordinator,
      reason: "no_configuration",
    };
  }

  const enableWrites = options.enableWrites === true;
  const enableProcesses = options.enableProcesses === true;

  // MCP servers are third-party processes. They start only when a declaration
  // exists AND an approval channel was supplied; a build with no channel cannot
  // start one, which is the safe default for a scripted launch.
  const mcpDeclared = readMcpDeclarations(options.settings);
  const mcpStarted =
    mcpDeclared === undefined || options.mcpApprovals === undefined
      ? null
      : await startMcpServers({
          declared: mcpDeclared,
          workspaceRoot: options.workspaceRoot,
          approvals: options.mcpApprovals,
          ...(options.spawnMcp === undefined ? {} : { spawnProcess: options.spawnMcp }),
        });
  const mcpExecutor =
    mcpStarted !== null && mcpStarted.ok && mcpStarted.connections.length > 0
      ? createMcpTools(mcpStarted.connections)
      : undefined;
  const discoverable = discoverableTools(mcpStarted);
  // With a handful of MCP tools, listing them is cheaper than a discovery round trip.
  // Past the threshold the schemas dominate the request, so only a compact server
  // catalog is sent and the model asks for the schemas it needs.
  const useDiscovery = shouldDiscover(discoverable.length);
  const discoverExecutor = useDiscovery
    ? createDiscoverToolsTool({ tools: () => discoverable })
    : undefined;
  const mcpWarnings =
    mcpStarted === null
      ? mcpDeclared === undefined
        ? []
        : ["mcp: servers are declared but no approval channel is available; none started"]
      : mcpStarted.ok
        ? mcpStarted.warnings
        : [`mcp: no server started (${mcpStarted.code})`];

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
    enableSkills: options.enableSkills === true,
    ...(mcpExecutor === undefined ? {} : { mcp: mcpExecutor }),
    ...(discoverExecutor === undefined ? {} : { discover: discoverExecutor }),
  });

  // Advertise only tools this composition actually exposes under the current
  // flags, so the model never sees a schema for something that would fail at call
  // time with tool_unavailable_in_build. `ask_user` is answered by the coordinator
  // rather than a tool executor, so it has no definition and is always available.
  const catalog = availableTools(
    (name) => name === COORDINATOR_TOOL_NAMES.ask_user || tools.getDefinition(name) !== null,
  );
  const mcpDefinitions =
    mcpStarted !== null && mcpStarted.ok ? mcpToolDefinitions(mcpStarted.connections) : [];
  const toolDefinitions = [
    ...catalog.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema as unknown as Readonly<Record<string, unknown>>,
    })),
    ...(useDiscovery
      ? [
          {
            name: DISCOVER_TOOLS_NAME,
            description: DISCOVERY_TOOL_DESCRIPTION,
            inputSchema: DISCOVERY_TOOL_SCHEMA,
          },
        ]
      : mcpDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))),
  ];

  // The catalog goes into the sourced project context, not the system prompt: it is
  // server-supplied text and must not acquire the authority of application rules.
  const mcpCatalogBlock = useDiscovery
    ? `[mcp-catalog]\nConnected MCP servers. Their tools are not listed here; use \`${DISCOVER_TOOLS_NAME}\` with a query to get a tool's schema before calling it.\n${renderServerCatalog(discoverable)}`
    : "";

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
      coordinator: createDemoRuntime(options.workspaceRoot, options.sessionId).coordinator,
      reason: assembly.code,
      ...(assembly.detail === undefined ? {} : { detail: assembly.detail }),
    };
  }

  // One sourced block holds guidance and the skill catalog, guidance first so a
  // skill description cannot appear to override project rules.
  const contextBlock = [guidance.block, skills.block, mcpCatalogBlock]
    .filter((part) => part !== "")
    .join("\n\n");

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
  const sessionId = options.sessionId ?? ids.create();
  let ownership: Awaited<ReturnType<typeof eventLog.acquireSessionOwnership>>;
  try {
    ownership = await eventLog.acquireSessionOwnership(sessionId);
  } catch {
    return {
      kind: "demo",
      coordinator: createDemoRuntime(options.workspaceRoot, sessionId).coordinator,
      reason: "session_busy",
      detail: "Session ownership unavailable; no real work may start",
    };
  }

  // Rebuild prior conversation so a resumed Session continues with its history.
  // A rebuild failure blocks sending; it must not silently start fresh.
  try {
    const prior = await rebuildPriorConversation(eventLog, sessionId, assembly.ownedKeys);
    const evidenceStore = createFileEvidenceStore({
      // Match the existing event/checkpoint storage layout without migrating logs.
      sessionDirectory: path.join(sessionRoot, "sessions", sessionId),
      sessionId,
      ownedKeys: assembly.ownedKeys,
      refreshOwnedKeys: assembly.refreshOwnedKeys,
    });
    let evidenceMissing = false;
    const restoredEvents = [...prior.events];
    const affectedRuns = new Set<string>();
    for (const event of prior.events) {
      const fact = event.payload;
      const toolCallId =
        fact.kind === "tool_execution_finished"
          ? fact.toolCallId
          : fact.kind === "background_task_observed"
            ? fact.task.launchingToolCallId
            : null;
      const evidence =
        fact.kind === "tool_execution_finished"
          ? fact.evidence
          : fact.kind === "background_task_observed" && "evidence" in fact.task
            ? fact.task.evidence
            : undefined;
      if (toolCallId === null) continue;
      if (evidence === undefined) continue;
      const verified = evidence.rawComplete
        ? await evidenceStore.verify(evidence, toolCallId)
        : { ok: false as const, code: "invalid_manifest" as const };
      if (!verified.ok) {
        evidenceMissing = true;
        for (const attachment of evidence.attachments) {
          const reason =
            verified.code === "attachment_missing"
              ? ("attachment_missing" as const)
              : ("hash_mismatch" as const);
          if (
            restoredEvents.some(
              ({ payload }) =>
                payload.kind === "evidence_unavailable" &&
                payload.toolCallId === toolCallId &&
                payload.ref.attachmentId === attachment.ref.attachmentId &&
                payload.reason === reason,
            )
          )
            continue;
          const input = {
            sessionId,
            runId: event.runId,
            correlationId: event.correlationId,
            causationId: restoredEvents.at(-1)?.eventId ?? null,
            timestampUtc: new Date().toISOString(),
            type: "evidence_unavailable" as const,
            payload: {
              kind: "evidence_unavailable" as const,
              toolCallId,
              ref: attachment.ref,
              reason,
            },
          };
          assertProtectedValue(assembly.ownedKeys, input);
          restoredEvents.push(await eventLog.append(input));
          affectedRuns.add(event.runId);
        }
      }
    }
    const background = new Map<string, InternalEvent>();
    for (const event of prior.events)
      if (event.payload.kind === "background_task_observed")
        background.set(event.payload.task.processExecutionId, event);
    for (const event of background.values()) {
      if (event.payload.kind !== "background_task_observed") continue;
      const task = event.payload.task;
      if (task.state !== "registered" && task.state !== "running") continue;
      const input = {
        sessionId,
        runId: event.runId,
        correlationId: event.correlationId,
        causationId: restoredEvents.at(-1)?.eventId ?? null,
        timestampUtc: new Date().toISOString(),
        type: "background_task_observed" as const,
        payload: {
          kind: "background_task_observed" as const,
          task: {
            ...task,
            state: "outcome_unknown" as const,
            observedAtUtc: new Date().toISOString(),
          },
        },
      };
      assertProtectedValue(assembly.ownedKeys, input);
      restoredEvents.push(await eventLog.append(input));
      affectedRuns.add(event.runId);
      evidenceMissing = true;
    }
    for (const runId of affectedRuns) {
      const previous = restoredEvents.findLast(
        ({ payload, runId: owner }) => owner === runId && payload.kind === "task_report_snapshot",
      );
      const started = restoredEvents.find(
        ({ payload, runId: owner }) => owner === runId && payload.kind === "run_started",
      );
      if (started !== undefined) {
        const derived = deriveTaskReport(restoredEvents, sessionId, runId);
        if (!derived.ok) throw new Error("task_report_invalid");
        const protocolRunState =
          previous?.payload.kind === "task_report_snapshot"
            ? previous.payload.protocolRunState
            : restoredProtocolState(restoredEvents, runId);
        const input = {
          sessionId,
          runId,
          correlationId: started.correlationId,
          causationId: restoredEvents.at(-1)?.eventId ?? null,
          timestampUtc: new Date().toISOString(),
          type: "task_report_snapshot" as const,
          payload: {
            kind: "task_report_snapshot" as const,
            protocolRunState,
            report: derived.value,
          },
        };
        assertProtectedValue(assembly.ownedKeys, input);
        restoredEvents.push(await eventLog.append(input));
      }
    }

    // Unknown capacity is distinct from a known window that cannot fit the prompt.
    const computed = computeContextBudget({
      window: assembly.config.contextWindow,
      modelMaxOutput: assembly.config.maxOutputTokens,
      userMaxOutput: assembly.config.maxOutputTokens,
      // The fixed part is the guidance block plus the tool schemas; both are sent
      // every request and are not reducible by summarisation.
      fixed: conservativeEstimate(estimateFixedTokens(contextBlock, toolDefinitions)),
    });
    const contextBudget = computed.ok ? computed.value : null;
    const budgetWarning = computed.ok ? null : `model requests blocked (${computed.code})`;

    return {
      kind: "real",
      config: assembly.config,
      enableWrites,
      warnings: [
        ...assembly.warnings,
        ...mcpWarnings,
        ...(budgetWarning === null ? [] : [budgetWarning]),
        ...(evidenceMissing
          ? ["stored evidence is incomplete or unavailable; verification remains blocked"]
          : []),
      ],
      coordinator: new RuntimeCoordinator({
        provider: assembly.provider,
        ownedKeys: assembly.ownedKeys,
        ...(options.enableSkills === true
          ? {
              loadSkill: async ({ skillId }) => {
                const loaded = await createSkillLoader({
                  workspaceRoot: options.workspaceRoot,
                }).load({
                  skillId,
                });
                return loaded.ok
                  ? { ok: true as const, block: loaded.block, skillId: loaded.skillId }
                  : { ok: false as const, code: loaded.code };
              },
            }
          : {}),
        refreshOwnedKeys: assembly.refreshOwnedKeys,
        tools: createWorkspaceTools({
          workspaceRoot: options.workspaceRoot,
          // No interactive channel is attached to this gate, so it denies. Tools
          // that require approval still suspend and reach the TUI.
          approvals: { decide: async () => "denied" },
          ids,
          enableWrites,
          enableProcesses,
          enableSkills: options.enableSkills === true,
          ownedKeys: assembly.ownedKeys,
          refreshOwnedKeys: assembly.refreshOwnedKeys,
          evidenceStore,
          ...(mcpExecutor === undefined ? {} : { mcp: mcpExecutor }),
          ...(discoverExecutor === undefined ? {} : { discover: discoverExecutor }),
        }),
        approvals: { decide: async () => "denied" },
        eventLog,
        checkpoints,
        ids,
        nowUtc: () => new Date().toISOString(),
        nowMs: () => performance.now(),
        persistReports: true,
        releaseSession: () => ownership.release(),
        runBinding: assembly.runBinding,
        resolveCredentialRevision: assembly.resolveCredentialRevision,
        requestFingerprint: assembly.requestFingerprint,
        sensitiveSources: restoreSensitiveSources(prior.events),
        ...(prior.summary.kind === "failed"
          ? { preflightFailure: "protocol_history_incompatible" as const }
          : !computed.ok
            ? {
                preflightFailure:
                  computed.code === "model_context_unknown"
                    ? ("model_context_unknown" as const)
                    : ("context_capacity_insufficient" as const),
              }
            : {}),
        suspendOnApproval: true,
        spillStore: createSpillStore({
          sessionDirectory: path.join(sessionRoot, "sessions", sessionId),
          workspaceRoot: options.workspaceRoot,
        }),
        snapshotStore: createSnapshotStore({
          sessionDirectory: path.join(sessionRoot, "sessions", sessionId),
          workspaceRoot: options.workspaceRoot,
        }),
        syntaxChecker: createSyntaxChecker({
          tscEntry: defaultTscEntry(process.cwd()),
          // The same C09 filter every other child process gets.
          environment: formatterEnvironment(),
        }),
        workspaceRoot: options.workspaceRoot,
        revertChanges: async ({ runId, workspaceRoot }) => {
          const undone = await undoSessionChanges({
            store: createSnapshotStore({
              sessionDirectory: path.join(sessionRoot, "sessions", sessionId),
              workspaceRoot,
            }),
            workspaceRoot,
            runIds: [runId],
          });
          return undone.ok
            ? { ok: true as const, files: undone.files }
            : { ok: false as const, code: undone.code };
        },
        formatter: createFormatterRunner({
          workspaceRoot: options.workspaceRoot,
          // The same C09 filter every other child process gets: a formatter has no
          // business seeing a Provider key.
          environment: formatterEnvironment(),
        }),
        resolveWorkspacePath: (relativePath) =>
          path.resolve(options.workspaceRoot, ...relativePath.split("/")),
        sessionId,
        ...(prior.conversation.length === 0 ? {} : { priorConversation: prior.conversation }),
        ...(contextBlock === "" ? {} : { projectContext: contextBlock }),
        // Unknown capacity blocks sends; there is no guessed window or silent trim.
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
      historyEvents: restoredEvents,
      skills: skills.summary,
    };
  } catch (error) {
    ownership.release();
    throw error;
  }
}

function restoredProtocolState(
  events: readonly InternalEvent[],
  runId: string,
): "active" | "waiting" | "completed" | "failed" | "cancelled" {
  let state: ReturnType<typeof restoredProtocolState> = "active";
  for (const event of events) {
    if (event.runId !== runId) continue;
    switch (event.payload.kind) {
      case "run_waiting":
        state = "waiting";
        break;
      case "run_resumed":
        state = "active";
        break;
      case "run_completed":
        state = "completed";
        break;
      case "run_failed":
        state = "failed";
        break;
      case "run_cancelled":
        state = "cancelled";
        break;
    }
  }
  return state;
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
  tools: readonly Readonly<{
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
  }>[],
): number {
  let total = Math.ceil(guidanceBlock.length / 4);
  for (const tool of tools) total += Math.ceil(JSON.stringify(tool).length / 4) + 50;
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
  ownedKeys: OwnedKeyRegistry,
): Promise<
  Readonly<{
    conversation: readonly ProviderConversationItem[];
    events: readonly InternalEvent[];
    summary: PriorSummary;
  }>
> {
  if (sessionId === undefined) {
    return { conversation: [], events: [], summary: { kind: "none" } };
  }
  try {
    const stored = await eventLog.readWithRecovery(sessionId);
    if (!stored.ok) {
      return { conversation: [], events: [], summary: { kind: "failed", code: stored.code } };
    }
    assertProtectedValue(ownedKeys, stored.events);
    const { rebuildConversation } = await import(
      "../application/coordinator/conversation-rebuild.ts"
    );
    const rebuilt = rebuildConversation(stored.events);
    if (!rebuilt.ok) {
      return { conversation: [], events: [], summary: { kind: "failed", code: rebuilt.code } };
    }
    if (rebuilt.conversation.length === 0) {
      return { conversation: [], events: stored.events, summary: { kind: "none" } };
    }
    // Bound the rebuilt history so a long Session does not consume the whole
    // context before the new task is even considered.
    return {
      conversation: rebuilt.conversation,
      events: stored.events,
      summary: { kind: "rebuilt", runs: rebuilt.runs, items: rebuilt.conversation.length },
    };
  } catch {
    return { conversation: [], events: [], summary: { kind: "failed", code: "rebuild_failed" } };
  }
}

function restoreSensitiveSources(events: readonly InternalEvent[]): readonly SensitiveSource[] {
  const sources = new Map<string, SensitiveSource>();
  const calls = new Map<string, { name: string; label: string }>();
  const approved = new Set<string>();
  const bindings = new Map<string, NonNullable<SensitiveSource["origin"]>>();
  for (const event of events) {
    const fact = event.payload;
    if (fact.kind === "run_model_binding") bindings.set(event.runId, fact);
    if (fact.kind === "sensitive_source_recorded") sources.set(fact.source.sourceId, fact.source);
    if (fact.kind === "tool_call_received")
      calls.set(fact.toolCallId, {
        name: fact.toolName,
        label:
          typeof fact.arguments === "object" &&
          fact.arguments !== null &&
          "path" in fact.arguments &&
          typeof fact.arguments.path === "string"
            ? fact.arguments.path
            : "legacy approved read",
      });
    if (fact.kind === "approval_decided" && fact.decision === "approved")
      approved.add(fact.toolCallId);
    if (
      fact.kind === "tool_execution_finished" &&
      fact.status === "succeeded" &&
      fact.text !== null
    ) {
      const call = calls.get(fact.toolCallId);
      if (
        !sources.has(fact.toolCallId) &&
        approved.has(fact.toolCallId) &&
        call !== undefined &&
        ["read_file", "grep", "glob", "list_dir"].includes(call.name)
      ) {
        sources.set(fact.toolCallId, {
          sourceId: fact.toolCallId,
          label: call.label,
          contentDigest: event.hash,
          origin: bindings.get(event.runId) ?? null,
        });
      }
    }
  }
  return [...sources.values()];
}

/**
 * The environment for a formatter child process.
 *
 * Built through the shared C09 filter rather than inherited, so a formatter cannot
 * read a credential the user never intended to expose. The formatter needs PATH
 * and, on Windows, the usual system variables, which the filter keeps.
 */
function formatterEnvironment(): Readonly<Record<string, string>> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  return filterChildEnvironment(inherited).environment;
}

/** Flatten connected MCP tools into the shape discovery matches against. */
function discoverableTools(
  started: Awaited<ReturnType<typeof startMcpServers>> | null,
): readonly DiscoverableTool[] {
  if (started === null || !started.ok) return [];
  return started.connections.flatMap((connection) =>
    connection.tools.map((tool) => ({
      name: tool.namespaced,
      serverId: connection.declaration.serverId,
      toolName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );
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
