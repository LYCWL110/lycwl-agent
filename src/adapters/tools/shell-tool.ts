import {
  filterChildEnvironment,
  formatShellPreview,
  renderShellPreview,
  type ShellRequest,
  validateShellRequest,
} from "../../domain/process/shell.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

/** Raw hard cap for Shell stdout + stderr combined (V1_BASELINE section 7). */
export const SHELL_RAW_CAP_BYTES = 8 * 1024 * 1024;
/** Model-facing text cap in UTF-16 code units. */
export const SHELL_MODEL_CAP_UNITS = 20_000;

export type ShellRunOutcome =
  | Readonly<{ kind: "completed"; exitCode: number; stdout: string; stderr: string }>
  | Readonly<{ kind: "timed_out"; stdout: string; stderr: string }>
  | Readonly<{ kind: "unknown"; safeCode: string }>;

export type ShellToolDependencies = Readonly<{
  sessionMode: "read_only" | "workspace_write";
  /** Environment inherited by the child process before filtering. */
  inheritedEnvironment: Readonly<Record<string, string>>;
  providerCredentialNames?: readonly string[];
  /**
   * Injected runner. A real adapter must use the Windows Job Object path,
   * bounded pipes and process-tree termination from G02.
   */
  runShell: (
    request: ShellRequest,
    environment: Readonly<Record<string, string>>,
  ) => Promise<ShellRunOutcome>;
}>;

export const SHELL_DEFINITION: ToolDefinition = {
  name: "shell",
  version: "1",
  sideEffectClass: "process_execution",
  requiresApproval: true,
  concurrencySafe: false,
};

export function createShellTool(dependencies: ShellToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return toolName === SHELL_DEFINITION.name ? SHELL_DEFINITION : null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      const validated = validateShellRequest(request.arguments, {
        sessionMode: dependencies.sessionMode,
      });
      if (!validated.ok) return `shell: ${validated.code}`;
      const filter = filterChildEnvironment(
        dependencies.inheritedEnvironment,
        {},
        {
          ...(dependencies.providerCredentialNames === undefined
            ? {}
            : { providerCredentialNames: dependencies.providerCredentialNames }),
          grantedNames: validated.value.environmentGrants,
        },
      );
      return formatShellPreview(renderShellPreview(validated.value, filter));
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const validated = validateShellRequest(request.arguments, {
        sessionMode: dependencies.sessionMode,
      });
      if (!validated.ok) {
        return { status: "failed", safeCode: validated.code, text: null };
      }
      const shellRequest = validated.value;

      const filter = filterChildEnvironment(
        dependencies.inheritedEnvironment,
        {},
        {
          ...(dependencies.providerCredentialNames === undefined
            ? {}
            : { providerCredentialNames: dependencies.providerCredentialNames }),
          grantedNames: shellRequest.environmentGrants,
        },
      );
      if (filter.missingGrantNames.length > 0) {
        return { status: "failed", safeCode: "environment_grant_missing", text: null };
      }

      let outcome: ShellRunOutcome;
      try {
        outcome = await dependencies.runShell(shellRequest, filter.environment);
      } catch {
        return { status: "outcome_unknown", safeCode: "shell_outcome_unknown" };
      }

      if (outcome.kind === "unknown") {
        return { status: "outcome_unknown", safeCode: outcome.safeCode };
      }

      const combined = outcome.stdout.length + outcome.stderr.length;
      if (combined > SHELL_RAW_CAP_BYTES) {
        // Evidence is incomplete; never claim the full output was captured.
        return {
          status: "failed",
          safeCode: "output_limit_exceeded",
          text: truncateForModel(outcome.stdout, outcome.stderr),
        };
      }

      const text = truncateForModel(outcome.stdout, outcome.stderr);
      if (outcome.kind === "timed_out") {
        return { status: "failed", safeCode: "shell_timeout", text };
      }
      if (outcome.exitCode !== 0) {
        return { status: "failed", safeCode: "nonzero_exit", text };
      }
      return { status: "succeeded", text };
    },
  };
}

function truncateForModel(stdout: string, stderr: string): string {
  const body = [
    "stdout:",
    stdout.length === 0 ? "(empty)" : stdout,
    "stderr:",
    stderr.length === 0 ? "(empty)" : stderr,
  ].join("\n");
  if (body.length <= SHELL_MODEL_CAP_UNITS) return body;
  return `${body.slice(0, SHELL_MODEL_CAP_UNITS)}\n[truncated: model budget]`;
}
