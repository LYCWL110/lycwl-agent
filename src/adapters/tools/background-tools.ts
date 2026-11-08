import {
  BACKGROUND_LIMITS,
  type BackgroundCursor,
  type BackgroundTask,
  canStopTask,
  describeTask,
  initialCursor,
  readBackgroundPage,
  validateBackgroundLabel,
  validateBackgroundTimeout,
} from "../../domain/process/background.ts";
import type { ShellRequest } from "../../domain/process/shell.ts";
import { filterChildEnvironment } from "../../domain/process/shell.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

export type BackgroundStartOutcome =
  | Readonly<{ kind: "started"; task: BackgroundTask }>
  | Readonly<{ kind: "unknown"; safeCode: string }>;

export type BackgroundToolDependencies = Readonly<{
  sessionMode: "read_only" | "workspace_write";
  inheritedEnvironment: Readonly<Record<string, string>>;
  providerCredentialNames?: readonly string[];
  /** Injected supervisor; a real adapter needs the G02 Job Object path. */
  startProcess: (
    request: ShellRequest,
    environment: Readonly<Record<string, string>>,
    label: string,
    toolCallId?: string,
    signal?: AbortSignal,
    owner?: ToolExecutionRequest["owner"],
  ) => Promise<BackgroundStartOutcome>;
  /** Read the current supervised state of a task. */
  getTask: (taskId: string) => Promise<BackgroundTask | null>;
  /** Supervised cancellation; never a bare PID kill. */
  stopTask: (taskId: string) => Promise<void>;
}>;

export const BACKGROUND_START_DEFINITION: ToolDefinition = {
  name: "background_start",
  version: "1",
  sideEffectClass: "process_execution",
  requiresApproval: true,
  concurrencySafe: false,
};

export const BACKGROUND_STATUS_DEFINITION: ToolDefinition = {
  name: "background_status",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export const BACKGROUND_OUTPUT_DEFINITION: ToolDefinition = {
  name: "background_output",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export const BACKGROUND_STOP_DEFINITION: ToolDefinition = {
  name: "background_stop",
  version: "1",
  sideEffectClass: "process_execution",
  requiresApproval: true,
  concurrencySafe: false,
};

const DEFINITIONS: readonly ToolDefinition[] = [
  BACKGROUND_START_DEFINITION,
  BACKGROUND_STATUS_DEFINITION,
  BACKGROUND_OUTPUT_DEFINITION,
  BACKGROUND_STOP_DEFINITION,
];

export function createBackgroundTools(dependencies: BackgroundToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return DEFINITIONS.find((definition) => definition.name === toolName) ?? null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      if (request.toolName === BACKGROUND_START_DEFINITION.name) {
        if (dependencies.sessionMode === "read_only") return "background_start: read_only_session";
        const parsed = parseStartArgs(request.arguments);
        if (!parsed.ok) return `background_start: ${parsed.code}`;
        return [
          "background_start",
          `command=${parsed.value.command}`,
          `cwd=${parsed.value.cwd}`,
          `timeoutMs=${parsed.value.timeoutMs}`,
          `label=${parsed.value.label ?? "(taskId)"}`,
          "effect=starts an external program in the background",
          "sandbox=none; environment filtering is not OS isolation",
        ].join("\n");
      }
      if (request.toolName === BACKGROUND_STOP_DEFINITION.name) {
        const taskId = readTaskId(request.arguments);
        if (!taskId.ok) return `background_stop: ${taskId.code}`;
        return [
          "background_stop",
          `taskId=${taskId.value}`,
          "effect=requests supervised termination of this task's process tree",
        ].join("\n");
      }
      return null;
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      switch (request.toolName) {
        case BACKGROUND_START_DEFINITION.name:
          return executeStart(
            dependencies,
            request.arguments,
            request.toolCallId,
            request.signal,
            request.owner,
          );
        case BACKGROUND_STATUS_DEFINITION.name:
          return executeStatus(dependencies, request.arguments);
        case BACKGROUND_OUTPUT_DEFINITION.name:
          return executeOutput(dependencies, request.arguments);
        case BACKGROUND_STOP_DEFINITION.name:
          return executeStop(dependencies, request.arguments);
        default:
          return { status: "failed", safeCode: "unknown_tool", text: null };
      }
    },
  };
}

type StartArgs = Readonly<{
  command: string;
  cwd: string;
  timeoutMs: number;
  label: string | null;
  environmentGrants: readonly string[];
}>;

type Parsed<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string }>;

function parseStartArgs(args: unknown): Parsed<StartArgs> {
  if (typeof args !== "object" || args === null) return { ok: false, code: "invalid_arguments" };
  const record = args as Record<string, unknown>;
  const command = record["command"];
  const cwd = record["cwd"];
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  if (typeof cwd !== "string" || cwd.length === 0) return { ok: false, code: "invalid_arguments" };

  const timeout = validateBackgroundTimeout(record["timeoutMs"]);
  if (!timeout.ok) return { ok: false, code: timeout.code };
  const label = validateBackgroundLabel(record["label"]);
  if (!label.ok) return { ok: false, code: label.code };

  const rawGrants = record["environmentGrants"];
  const environmentGrants: string[] = [];
  if (rawGrants !== undefined) {
    if (!Array.isArray(rawGrants) || rawGrants.length > 16) {
      return { ok: false, code: "invalid_arguments" };
    }
    const seen = new Set<string>();
    for (const entry of rawGrants) {
      if (typeof entry !== "string" || entry.length === 0) {
        return { ok: false, code: "invalid_arguments" };
      }
      const key = entry.toUpperCase();
      if (seen.has(key)) return { ok: false, code: "invalid_arguments" };
      seen.add(key);
      environmentGrants.push(entry);
    }
  }

  return {
    ok: true,
    value: {
      command,
      cwd,
      timeoutMs: timeout.value,
      label: label.value,
      environmentGrants,
    },
  };
}

function readTaskId(args: unknown): Parsed<string> {
  if (typeof args !== "object" || args === null) return { ok: false, code: "invalid_arguments" };
  const taskId = (args as Record<string, unknown>)["taskId"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  return { ok: true, value: taskId };
}

async function executeStart(
  dependencies: BackgroundToolDependencies,
  args: unknown,
  toolCallId: string,
  signal?: AbortSignal,
  owner?: ToolExecutionRequest["owner"],
): Promise<ToolExecutionResult> {
  if (dependencies.sessionMode === "read_only") {
    return { status: "failed", safeCode: "read_only_session", text: null };
  }
  const parsed = parseStartArgs(args);
  if (!parsed.ok) return { status: "failed", safeCode: parsed.code, text: null };

  const filter = filterChildEnvironment(
    dependencies.inheritedEnvironment,
    {},
    {
      ...(dependencies.providerCredentialNames === undefined
        ? {}
        : { providerCredentialNames: dependencies.providerCredentialNames }),
      grantedNames: parsed.value.environmentGrants,
    },
  );
  if (filter.missingGrantNames.length > 0) {
    return { status: "failed", safeCode: "environment_grant_missing", text: null };
  }

  let outcome: BackgroundStartOutcome;
  try {
    if (signal?.aborted) return { status: "failed", safeCode: "tool_cancelled", text: null };
    outcome = await dependencies.startProcess(
      {
        command: parsed.value.command,
        cwd: parsed.value.cwd,
        timeoutMs: parsed.value.timeoutMs,
        environmentGrants: parsed.value.environmentGrants,
      },
      filter.environment,
      parsed.value.label ?? "",
      toolCallId,
      signal,
      owner,
    );
  } catch {
    return { status: "outcome_unknown", safeCode: "background_start_unknown" };
  }
  if (outcome.kind === "unknown") {
    return { status: "outcome_unknown", safeCode: outcome.safeCode };
  }

  return {
    status: "succeeded",
    text: [
      `background_start: taskId=${outcome.task.taskId}`,
      `label=${outcome.task.label}`,
      `timeoutMs=${parsed.value.timeoutMs}`,
      "launch=accepted; this confirms start only, not completion or success",
    ].join("\n"),
  };
}

async function executeStatus(
  dependencies: BackgroundToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  const taskId = readTaskId(args);
  if (!taskId.ok) return { status: "failed", safeCode: taskId.code, text: null };
  const task = await dependencies.getTask(taskId.value);
  if (task === null) return { status: "failed", safeCode: "unknown_task", text: null };
  if (task.deliveryBlocked !== undefined)
    return { status: "succeeded", text: null, deliveryBlocked: task.deliveryBlocked };
  return { status: "succeeded", text: describeTask(task) };
}

async function executeOutput(
  dependencies: BackgroundToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  if (typeof args !== "object" || args === null) {
    return { status: "failed", safeCode: "invalid_arguments", text: null };
  }
  const record = args as Record<string, unknown>;
  const taskId = readTaskId(record);
  if (!taskId.ok) return { status: "failed", safeCode: taskId.code, text: null };

  const task = await dependencies.getTask(taskId.value);
  if (task === null) return { status: "failed", safeCode: "unknown_task", text: null };
  if (task.deliveryBlocked !== undefined)
    return { status: "succeeded", text: null, deliveryBlocked: task.deliveryBlocked };

  const cursor = readCursor(record["cursor"], task);
  if (!cursor.ok) return { status: "failed", safeCode: cursor.code, text: null };

  const rawPageBytes = record["pageBytes"];
  const pageBytes = rawPageBytes === undefined ? BACKGROUND_LIMITS.defaultPageBytes : rawPageBytes;
  if (typeof pageBytes !== "number") {
    return { status: "failed", safeCode: "invalid_arguments", text: null };
  }

  const page = readBackgroundPage(task, cursor.value, pageBytes);
  if (!page.ok) return { status: "failed", safeCode: page.code, text: null };

  const body = page.value.segments
    .map((segment) => `[${segment.stream}@${segment.streamByteStart}] ${segment.text}`)
    .join("");
  const header = [
    `background_output: ${page.value.segments.length} segment(s)`,
    `taskId=${task.taskId}`,
    `processExecutionId=${task.processExecutionId}`,
    `caughtUp=${page.value.caughtUp}`,
    `taskEnded=${page.value.taskEnded}`,
    `captureComplete=${page.value.captureComplete}`,
    `nextCursor=${page.value.nextCursor.recordIndex}:${page.value.nextCursor.recordByteOffset}`,
  ].join("; ");
  return { status: "succeeded", text: `${header}\n${body}` };
}

function readCursor(value: unknown, task: BackgroundTask): Parsed<BackgroundCursor> {
  if (value === undefined) return { ok: true, value: initialCursor(task) };
  if (typeof value !== "object" || value === null) {
    return { ok: false, code: "invalid_cursor" };
  }
  const record = value as Record<string, unknown>;
  const taskId = record["taskId"];
  const processExecutionId = record["processExecutionId"];
  const recordIndex = record["recordIndex"];
  const recordByteOffset = record["recordByteOffset"];
  if (
    typeof taskId !== "string" ||
    typeof processExecutionId !== "string" ||
    typeof recordIndex !== "number" ||
    typeof recordByteOffset !== "number"
  ) {
    return { ok: false, code: "invalid_cursor" };
  }
  return {
    ok: true,
    value: { taskId, processExecutionId, recordIndex, recordByteOffset },
  };
}

async function executeStop(
  dependencies: BackgroundToolDependencies,
  args: unknown,
): Promise<ToolExecutionResult> {
  const taskId = readTaskId(args);
  if (!taskId.ok) return { status: "failed", safeCode: taskId.code, text: null };

  const task = await dependencies.getTask(taskId.value);
  if (task === null) return { status: "failed", safeCode: "unknown_task", text: null };
  const stoppable = canStopTask(task);
  if (!stoppable.ok) return { status: "failed", safeCode: stoppable.code, text: null };

  try {
    await dependencies.stopTask(taskId.value);
  } catch {
    return { status: "outcome_unknown", safeCode: "background_stop_unknown" };
  }
  return {
    status: "succeeded",
    text: `background_stop: requested supervised termination of ${taskId.value}`,
  };
}
