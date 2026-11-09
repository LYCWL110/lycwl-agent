import type {
  PendingApprovalView,
  PendingDisclosureView,
  PendingQuestionView,
} from "../application/coordinator/runtime-coordinator.ts";
import { isSessionId } from "../domain/identity/session-id.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import type { ProviderImage } from "../ports/model-provider.ts";

/**
 * TUI view model (V1_DESIGN_SUPPLEMENTS S02). The TUI reads projections and
 * submits commands; it never executes tools or decides permissions. Everything
 * here is a pure derivation from authoritative Runtime facts.
 */
export type TranscriptEntry = Readonly<{
  id: string;
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
  /** Tool entries keep their terminal status so failures stay visible. */
  status: string | null;
  tool?: Readonly<{ name: string; summary: string; details: string }>;
}>;

export type RunStatus = "idle" | "active" | "waiting" | "completed" | "failed" | "cancelled";

export type WaitingKind = "approval" | "question" | "configuration" | "other";
export type RunActivity = "thinking" | "working";

export type TuiViewState = Readonly<{
  localPanel?: "help" | "session" | "credential" | "skills" | "mcp" | "sessions" | null;
  /** Workspace Skill catalog, when discovery ran and succeeded. */
  skillCatalog?:
    | readonly Readonly<{
        skillId: string;
        description: string;
        bytes: number;
      }>[]
    | null;
  /** Why the catalog is unavailable, when it is. */
  skillCatalogError?: string | null;
  /** Declared MCP servers, loaded when the panel opens. */
  mcpServers?:
    | readonly Readonly<{
        serverId: string;
        command: string;
        args: readonly string[];
      }>[]
    | null;
  /** Why the MCP server list could not be read, when it could not. */
  mcpError?: string | null;
  /** True while an MCP edit is being saved. */
  mcpBusy?: boolean;
  /** Every recorded session, newest first, loaded when the panel opens. */
  sessionList?:
    | readonly Readonly<{
        sessionId: string;
        label: string;
        title: string | null;
        modifiedAtUtc: string;
        bytes: number;
        current: boolean;
      }>[]
    | null;
  /** Why the session list could not be read, when it could not. */
  sessionListError?: string | null;
  /** True while a rename or delete is in flight. */
  sessionListBusy?: boolean;
  commandNotice?: string | null;
  runStatus: RunStatus;
  waitingKind: WaitingKind | null;
  activity: RunActivity | null;
  safeCode: string | null;
  transcript: readonly TranscriptEntry[];
  todo: TodoList | null;
  pendingApproval: PendingApprovalView | null;
  pendingDisclosure?: PendingDisclosureView | null;
  /**
   * The exact preview shown to the user for the pending approval. A null preview
   * means the approval panel cannot honestly describe the operation, so it must
   * not invite an approval.
   */
  pendingApprovalPreview: readonly string[] | null;
  /** Why the last question answer was rejected; null when there is no error. */
  answerError: string | null;
  /** Context window occupancy, or null when nothing is known yet. */
  meter: Readonly<{
    used: number;
    window: number | null;
    fraction: number | null;
    source: "measured" | "estimated";
    atCompaction: boolean;
  }> | null;
  /**
   * Token usage for the last finished Run. Absent when the provider reported none,
   * which is shown as unknown rather than as zero.
   */
  usage?: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }> | null;
  pendingQuestion: PendingQuestionView | null;
  /** Composer text is local draft state, never an accepted command. */
  draft: string;
  /** True when the user may submit a new task. */
  canSubmit: boolean;
  /** True when the input is queued for the running Run instead of starting one. */
  queueingInput: boolean;
}>;

export const EMPTY_VIEW: TuiViewState = {
  runStatus: "idle",
  waitingKind: null,
  activity: null,
  safeCode: null,
  transcript: [],
  todo: null,
  pendingApproval: null,
  pendingDisclosure: null,
  pendingApprovalPreview: null,
  answerError: null,
  pendingQuestion: null,
  draft: "",
  canSubmit: true,
  queueingInput: false,
  meter: null,
};

export type ViewInput = Readonly<{
  runStatus: RunStatus;
  safeCode: string | null;
  events: readonly InternalEvent[];
  todo: TodoList | null;
  pendingApproval: PendingApprovalView | null;
  pendingDisclosure?: PendingDisclosureView | null;
  pendingQuestion: PendingQuestionView | null;
  /** Set by the controller when an answer could not be resolved. */
  answerError?: string | null;
  draft: string;
}>;

/**
 * Derive the renderable state. Waiting kind is derived from the event chain and
 * live pending views, so a closed question panel still shows the wait.
 */
export function deriveView(input: ViewInput): TuiViewState {
  const waitingKind = deriveWaitingKind(input);
  const runStatus = input.runStatus;
  return {
    runStatus,
    waitingKind,
    activity: deriveActivity(input, waitingKind),
    safeCode: input.safeCode,
    transcript: buildTranscript(input.events),
    todo: input.todo,
    pendingApproval: input.pendingApproval,
    pendingDisclosure: input.pendingDisclosure ?? null,
    pendingApprovalPreview: deriveApprovalPreview(input),
    answerError: input.answerError ?? null,
    meter: null,
    pendingQuestion: input.pendingQuestion,
    draft: input.draft,
    canSubmit: runStatus !== "active" && waitingKind === null,
    queueingInput: runStatus === "active" || waitingKind !== null,
  };
}

function deriveActivity(input: ViewInput, waiting: WaitingKind | null): RunActivity | null {
  if (input.runStatus !== "active" || waiting !== null) return null;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    switch (input.events[index]?.payload.kind) {
      case "run_cancel_requested":
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
        return null;
      case "model_request_started":
      case "model_retry_scheduled":
        return "thinking";
      case "model_response_validated":
      case "tool_execution_started":
      case "tool_execution_finished":
      case "run_started":
      case "run_resumed":
        return "working";
    }
  }
  return null;
}

/**
 * The preview is read from the authoritative `approval_requested` event for the
 * pending approval, not from local state. The panel must show what the Runtime
 * actually recorded, so a stale local copy cannot become the thing the user
 * approves.
 */
function deriveApprovalPreview(input: ViewInput): readonly string[] | null {
  const pending = input.pendingApproval;
  if (pending === null) return null;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const payload = input.events[index]?.payload;
    if (payload === undefined) continue;
    if (payload.kind !== "approval_requested") continue;
    if (payload.approvalId !== pending.approvalId) continue;
    return payload.safePreview.split("\n");
  }
  // No recorded preview: the panel cannot describe the operation, so it offers
  // no preview rather than inventing one.
  return null;
}

function deriveWaitingKind(input: ViewInput): WaitingKind | null {
  if (input.pendingDisclosure != null) return "approval";
  if (input.pendingApproval !== null) return "approval";
  if (input.pendingQuestion !== null) return "question";
  if (input.runStatus !== "active" && input.runStatus !== "waiting") return null;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const payload = input.events[index]?.payload;
    if (payload === undefined) continue;
    if (payload.kind === "run_waiting") {
      if (payload.reason === "approval") return "approval";
      if (payload.reason === "user_input") return "question";
      if (payload.reason === "configuration") return "configuration";
      return "other";
    }
    if (
      payload.kind === "run_completed" ||
      payload.kind === "run_failed" ||
      payload.kind === "run_cancelled" ||
      payload.kind === "run_started" ||
      payload.kind === "run_resumed"
    ) {
      return null;
    }
  }
  return null;
}

function buildTranscript(events: readonly InternalEvent[]): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, number>();
  const inputs = new Map<string, number>();
  const requests = new Map<string, readonly string[]>();
  const consumed = new Set<string>();
  const inputRuns = new Map<number, string>();
  const terminalRuns = new Set<string>();
  const pausedRuns = new Set<string>();
  const key = (runId: string, id: string) => `${runId}:${id}`;
  function updateTool(
    event: InternalEvent,
    toolCallId: string,
    name: string | undefined,
    status: string,
    result?: string | null,
  ): void {
    const id = key(event.runId, toolCallId);
    let index = tools.get(id);
    if (index === undefined) {
      index = entries.length;
      tools.set(id, index);
      entries.push({
        id: event.eventId,
        kind: "tool",
        text: `${name ?? "tool"} ${status}`,
        status,
        tool: { name: name ?? "tool", summary: name ?? "tool", details: "" },
      });
    }
    const previous = entries[index];
    if (previous === undefined) return;
    const toolName = previous.tool?.name ?? name ?? "tool";
    entries[index] = {
      ...previous,
      text: result ?? `${toolName} ${status}`,
      status,
      tool: {
        name: toolName,
        summary: previous.tool?.summary ?? toolName,
        details: `${previous.tool?.details ?? ""}${result == null ? "" : `\n${result}`}`.trim(),
      },
    };
  }

  for (const event of events) {
    const payload = event.payload;
    switch (payload.kind) {
      case "run_input_queued":
        inputs.set(key(event.runId, payload.inputId), entries.length);
        inputRuns.set(entries.length, event.runId);
        entries.push({ id: event.eventId, kind: "user", text: payload.text, status: "queued" });
        break;
      case "run_input_withdrawn": {
        const index = inputs.get(key(event.runId, payload.inputId));
        const previous = index === undefined ? undefined : entries[index];
        if (previous !== undefined && index !== undefined)
          entries[index] = { ...previous, status: "withdrawn" };
        break;
      }
      case "run_input_batch_consumed":
        for (const id of payload.inputIds) {
          const inputKey = key(event.runId, id);
          consumed.add(inputKey);
          const index = inputs.get(inputKey);
          const previous = index === undefined ? undefined : entries[index];
          if (previous !== undefined && index !== undefined)
            entries[index] = { ...previous, status: "ready" };
        }
        break;
      case "model_request_started": {
        const included = (payload.includedInputIds ?? []).map((id) => key(event.runId, id));
        requests.set(key(event.runId, payload.modelRequestId), included);
        for (const id of included) {
          const index = inputs.get(id);
          const previous = index === undefined ? undefined : entries[index];
          if (previous !== undefined && index !== undefined && previous.status !== "sent")
            entries[index] = { ...previous, status: "sending" };
        }
        break;
      }
      case "run_started":
        entries.push({
          id: event.eventId,
          kind: "user",
          text: payload.input,
          status: null,
        });
        break;
      case "model_response_validated":
        for (const id of requests.get(key(event.runId, payload.modelRequestId)) ?? []) {
          const index = inputs.get(id);
          const previous = index === undefined ? undefined : entries[index];
          if (previous !== undefined && index !== undefined && consumed.has(id))
            entries[index] = { ...previous, status: "sent" };
        }
        if (payload.text !== null && payload.text.length > 0) {
          entries.push({
            id: event.eventId,
            kind: "assistant",
            text: payload.text,
            status: null,
          });
        }
        break;
      case "tool_call_received": {
        updateTool(event, payload.toolCallId, payload.toolName, "requested");
        const index = tools.get(key(event.runId, payload.toolCallId));
        const previous = index === undefined ? undefined : entries[index];
        if (previous !== undefined && index !== undefined)
          entries[index] = {
            ...previous,
            tool: {
              name: payload.toolName,
              summary: toolSummary(payload.toolName, payload.arguments),
              details: JSON.stringify(payload.arguments, null, 2) ?? "",
            },
          };
        break;
      }
      case "approval_requested":
        updateTool(event, payload.toolCallId, payload.toolName, "awaiting approval");
        break;
      case "tool_execution_started":
        updateTool(event, payload.toolCallId, payload.toolName, "running");
        break;
      case "tool_execution_finished": {
        updateTool(
          event,
          payload.toolCallId,
          payload.toolName,
          payload.status,
          [
            payload.safeCode,
            payload.text,
            ...(payload.evidence === undefined
              ? []
              : [
                  `evidence=${payload.evidence.rawComplete ? "complete" : payload.evidence.rawTruncationReason}; bytes=${payload.evidence.capturedBytes}`,
                  ...payload.evidence.attachments.map(
                    ({ stream, ref }) =>
                      `${stream}: ${ref.attachmentId} sha256=${ref.sha256} bytes=[${ref.start},${ref.end})`,
                  ),
                ]),
          ]
            .filter((text) => text != null)
            .join("\n") || null,
        );
        break;
      }
      case "tool_execution_denied":
        updateTool(event, payload.toolCallId, payload.toolName, "denied");
        break;
      case "tool_call_cancelled":
        updateTool(event, payload.toolCallId, payload.toolName, "cancelled", payload.reason);
        break;
      case "run_waiting":
        pausedRuns.add(event.runId);
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `waiting: ${payload.reason} (${payload.safeCode})`,
          status: null,
        });
        break;
      case "run_resumed":
        pausedRuns.delete(event.runId);
        break;
      case "run_completed":
        terminalRuns.add(event.runId);
        break;
      case "run_failed":
        terminalRuns.add(event.runId);
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `run failed: ${payload.safeCode}`,
          status: "failed",
        });
        break;
      case "run_cancelled":
        terminalRuns.add(event.runId);
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `run cancelled: ${payload.safeCode}`,
          status: "cancelled",
        });
        break;
      default:
        break;
    }
  }
  for (const index of inputs.values()) {
    const entry = entries[index];
    const runId = inputRuns.get(index);
    if (
      entry === undefined ||
      runId === undefined ||
      entry.status === "sent" ||
      entry.status === "withdrawn"
    )
      continue;
    if (terminalRuns.has(runId)) {
      entries[index] = { ...entry, status: entry.status === "sending" ? "unknown" : "retained" };
    } else if (pausedRuns.has(runId) && entry.status === "sending") {
      entries[index] = { ...entry, status: "unknown" };
    }
  }
  return entries;
}

function toolSummary(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return name;
  const fields = args as Record<string, unknown>;
  const target =
    fields["command"] ?? fields["path"] ?? fields["pattern"] ?? fields["query"] ?? fields["url"];
  return typeof target === "string" ? `${name} ${target.replace(/\s+/gu, " ")}` : name;
}

/**
 * The composer never turns raw text into an approval, disclosure consent or
 * ResumeRun. It either starts a new task or queues ordinary input.
 */
export type ComposerIntent =
  | Readonly<{
      kind: "start_run";
      text: string;
      /** Present when the composer asked to load a skill for this Run. */
      skillId?: string;
      /** Images to attach to the task turn. */
      images?: readonly ProviderImage[];
    }>
  | Readonly<{ kind: "queue_input"; text: string }>
  | Readonly<{ kind: "withdraw"; inputId: string }>
  /** Open the provider browser. Only available when no Run is in flight. */
  | Readonly<{ kind: "open_config" }>
  /** Generate an AGENTS.md draft for the workspace. */
  | Readonly<{ kind: "project_init" }>
  | Readonly<{ kind: "open_model" }>
  | Readonly<{ kind: "open_panel"; panel: "help" | "session" | "skills" | "mcp" | "sessions" }>
  | Readonly<{ kind: "undo_changes" }>
  | Readonly<{ kind: "rename_session"; sessionId: string; title: string | null }>
  | Readonly<{ kind: "delete_session"; sessionId: string }>
  | Readonly<{ kind: "switch_session"; sessionId: string | null }>
  | Readonly<{ kind: "cancel_run" }>
  | Readonly<{ kind: "resume_run" }>
  | Readonly<{ kind: "correct_credential" }>
  | Readonly<{ kind: "quit" }>
  | Readonly<{
      kind: "reject";
      reason: "empty" | "run_active" | "unknown_command" | "invalid_command";
    }>;

export const COMPOSER_COMMANDS = [
  { name: "/config", description: "Provider settings", idleOnly: true },
  { name: "/model", description: "Select model and reasoning", idleOnly: true },
  { name: "/session", description: "Current, new or resume session", idleOnly: true },
  { name: "/sessions", description: "List, rename or delete recorded sessions", idleOnly: true },
  { name: "/new", description: "Start a fresh session", idleOnly: true },
  { name: "/init", description: "Draft an AGENTS.md for this project", idleOnly: true },
  { name: "/skill", description: "Run with a workspace skill loaded", idleOnly: true },
  { name: "/skills", description: "List the workspace skill catalog", idleOnly: false },
  { name: "/mcp", description: "Declare MCP servers", idleOnly: true },
  { name: "/undo", description: "Revert the files this session changed", idleOnly: true },
  { name: "/help", description: "Show commands", idleOnly: false },
  { name: "/cancel", description: "Cancel the current run", idleOnly: false },
  { name: "/key", description: "Correct the waiting connection key", idleOnly: false },
  { name: "/resume", description: "Explicitly resume after key correction", idleOnly: false },
  { name: "/quit", description: "Close the application", idleOnly: false },
] as const;

export function commandEnabled(
  view: TuiViewState,
  command: (typeof COMPOSER_COMMANDS)[number],
): boolean {
  if (command.name === "/key" || command.name === "/resume")
    return view.runStatus === "waiting" && view.waitingKind === "configuration";
  return (
    !command.idleOnly ||
    (view.runStatus !== "active" && view.runStatus !== "waiting" && view.waitingKind === null)
  );
}

export function interpretComposer(
  view: TuiViewState,
  text: string,
  options: Readonly<{ activeRunAcceptsInput: boolean }> = { activeRunAcceptsInput: true },
  /**
   * Images pasted alongside the text.
   *
   * They ride on the task turn rather than forming a turn of their own: the model
   * must read them as part of the request. A slash command is text-only, so an
   * attached image on a command is refused rather than silently dropped.
   */
  images?: readonly ProviderImage[],
): ComposerIntent {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "reject", reason: "empty" };
  const [name, ...args] = trimmed.split(/\s+/u);
  const command = COMPOSER_COMMANDS.find((entry) => entry.name === name);
  if (command !== undefined) {
    if (!commandEnabled(view, command)) {
      return { kind: "reject", reason: "run_active" };
    }
    if (args.length > 0 && name !== "/session" && name !== "/skill")
      return { kind: "reject", reason: "invalid_command" };
    switch (name) {
      case "/config":
        return { kind: "open_config" };
      case "/model":
        return { kind: "open_model" };
      case "/sessions":
        return { kind: "open_panel", panel: "sessions" };
      case "/session":
        if (args.length === 0) return { kind: "open_panel", panel: "session" };
        if (args.length === 2 && args[0] === "resume" && isSessionId(args[1] ?? ""))
          return { kind: "switch_session", sessionId: args[1] ?? null };
        if (args.length !== 1 || args[0] === "resume")
          return { kind: "reject", reason: "invalid_command" };
        if (args[0] === "new") return { kind: "switch_session", sessionId: null };
        if (!isSessionId(args[0] ?? "")) return { kind: "reject", reason: "invalid_command" };
        return { kind: "switch_session", sessionId: args[0] ?? null };
      case "/new":
        return { kind: "switch_session", sessionId: null };
      case "/init":
        return { kind: "project_init" };
      case "/skills":
        return { kind: "open_panel", panel: "skills" };
      case "/mcp":
        return { kind: "open_panel", panel: "mcp" };
      case "/undo":
        return { kind: "undo_changes" };
      case "/skill": {
        // The id becomes part of the task text so the coordinator can resolve and
        // inject the body at the same safe boundary as any other input.
        const skillId = args[0] ?? "";
        if (args.length !== 1 || !isValidSkillIdForCommand(skillId)) {
          return { kind: "reject", reason: "invalid_command" };
        }
        return { kind: "start_run", text: `/skill ${skillId}`, skillId };
      }
      case "/help":
        return { kind: "open_panel", panel: "help" };
      case "/cancel":
        return { kind: "cancel_run" };
      case "/key":
        return { kind: "correct_credential" };
      case "/resume":
        return { kind: "resume_run" };
      case "/quit":
        return { kind: "quit" };
    }
  }
  if (/^\/[a-z]+(?:\s|$)/iu.test(trimmed)) return { kind: "reject", reason: "unknown_command" };
  if (view.runStatus === "active" || view.waitingKind !== null) {
    if (!options.activeRunAcceptsInput) return { kind: "reject", reason: "run_active" };
    return { kind: "queue_input", text: trimmed };
  }
  if (view.runStatus === "waiting") return { kind: "reject", reason: "run_active" };
  return images === undefined || images.length === 0
    ? { kind: "start_run", text: trimmed }
    : { kind: "start_run", text: trimmed, images };
}

/**
 * Closing an approval or question panel is a view action. It must never be
 * interpreted as an answer, a decision or a resume.
 */
export type PanelAction = "close" | "open";

export function panelActionKeepsWait(action: PanelAction): boolean {
  return action === "close" || action === "open";
}

/**
 * Validate a skill id at the command layer.
 *
 * The loader validates again; this exists so a malformed id is rejected as a command
 * error rather than starting a Run that would fail at the tool.
 */
function isValidSkillIdForCommand(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(value) && value.length <= 64;
}
