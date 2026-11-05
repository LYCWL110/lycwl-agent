import type { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.ts";
import type { ProviderConfig } from "../domain/config/provider-config.ts";
import { availableTools } from "../domain/tool-catalog/tool-catalog.ts";
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

  const tools = createWorkspaceTools({
    workspaceRoot: options.workspaceRoot,
    approvals: { decide: async () => "denied" },
    ids: { create: () => "probe" },
    enableWrites: false,
    enableProcesses: false,
  });

  // Advertise only tools this composition actually exposes under the current
  // flags, so the model never sees a schema for something that would fail at call
  // time with tool_unavailable_in_build.
  const catalog = availableTools((name) => tools.getDefinition(name) !== null);
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
    warnings: assembly.warnings,
    coordinator: new RuntimeCoordinator({
      provider: assembly.provider,
      tools: createWorkspaceTools({
        workspaceRoot: options.workspaceRoot,
        // No interactive channel is attached to this gate, so it denies. Tools
        // that require approval still suspend and reach the TUI.
        approvals: { decide: async () => "denied" },
        ids,
        enableWrites: false,
        enableProcesses: false,
      }),
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
    }),
  };
}

/** Human-readable launch summary, printed before the TUI takes the screen. */
export function describeSelection(selection: RuntimeSelection): readonly string[] {
  if (selection.kind === "real") {
    return [
      `mode: real provider`,
      `model: ${selection.config.model}`,
      `endpoint: ${selection.config.baseUrl}`,
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
