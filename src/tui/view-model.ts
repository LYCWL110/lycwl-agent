import type {
  PendingApprovalView,
  PendingQuestionView,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";

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
}>;

export type RunStatus = "idle" | "active" | "waiting" | "completed" | "failed" | "cancelled";

export type WaitingKind = "approval" | "question" | "configuration" | "other";

export type TuiViewState = Readonly<{
  runStatus: RunStatus;
  waitingKind: WaitingKind | null;
  safeCode: string | null;
  transcript: readonly TranscriptEntry[];
  todo: TodoList | null;
  pendingApproval: PendingApprovalView | null;
  /**
   * The exact preview shown to the user for the pending approval. A null preview
   * means the approval panel cannot honestly describe the operation, so it must
   * not invite an approval.
   */
  pendingApprovalPreview: readonly string[] | null;
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
  safeCode: null,
  transcript: [],
  todo: null,
  pendingApproval: null,
  pendingApprovalPreview: null,
  pendingQuestion: null,
  draft: "",
  canSubmit: true,
  queueingInput: false,
};

export type ViewInput = Readonly<{
  runStatus: RunStatus;
  safeCode: string | null;
  events: readonly InternalEvent[];
  todo: TodoList | null;
  pendingApproval: PendingApprovalView | null;
  pendingQuestion: PendingQuestionView | null;
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
    safeCode: input.safeCode,
    transcript: buildTranscript(input.events),
    todo: input.todo,
    pendingApproval: input.pendingApproval,
    pendingApprovalPreview: deriveApprovalPreview(input),
    pendingQuestion: input.pendingQuestion,
    draft: input.draft,
    canSubmit: runStatus !== "active" && waitingKind === null,
    queueingInput: runStatus === "active" || waitingKind !== null,
  };
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
  if (input.pendingApproval !== null) return "approval";
  if (input.pendingQuestion !== null) return "question";
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const payload = input.events[index]?.payload;
    if (payload === undefined) continue;
    if (payload.kind === "run_waiting") {
      if (payload.reason === "approval") return "approval";
      if (payload.reason === "user_input") return "question";
      if (payload.reason === "configuration") return "configuration";
      return "other";
    }    if (
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
  const toolNames = new Map<string, string>();

  for (const event of events) {
    const payload = event.payload;
    switch (payload.kind) {
      case "run_started":
        entries.push({
          id: event.eventId,
          kind: "user",
          text: payload.input,
          status: null,
        });
        break;
      case "model_response_validated":
        if (payload.text !== null && payload.text.length > 0) {
          entries.push({
            id: event.eventId,
            kind: "assistant",
            text: payload.text,
            status: null,
          });
        }
        break;
      case "tool_call_received":
        toolNames.set(payload.toolCallId, payload.toolName);
        entries.push({
          id: event.eventId,
          kind: "tool",
          text: `${payload.toolName} requested`,
          status: "requested",
        });
        break;
      case "tool_execution_finished": {
        const name = toolNames.get(payload.toolCallId) ?? "tool";
        entries.push({
          id: event.eventId,
          kind: "tool",
          text: payload.text ?? `${name} ${payload.status}`,
          status: payload.status,
        });
        break;
      }
      case "tool_execution_denied":
        entries.push({
          id: event.eventId,
          kind: "tool",
          text: `${toolNames.get(payload.toolCallId) ?? "tool"} denied`,
          status: "denied",
        });
        break;
      case "tool_call_cancelled":
        entries.push({
          id: event.eventId,
          kind: "tool",
          text: `${payload.toolName} cancelled (${payload.reason})`,
          status: "cancelled",
        });
        break;
      case "run_waiting":
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `waiting: ${payload.reason} (${payload.safeCode})`,
          status: null,
        });
        break;
      case "run_completed":
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `run completed${payload.text === null ? "" : `: ${payload.text}`}`,
          status: "completed",
        });
        break;
      case "run_failed":
        entries.push({
          id: event.eventId,
          kind: "system",
          text: `run failed: ${payload.safeCode}`,
          status: "failed",
        });
        break;
      case "run_cancelled":
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
  return entries;
}

/**
 * The composer never turns raw text into an approval, disclosure consent or
 * ResumeRun. It either starts a new task or queues ordinary input.
 */
export type ComposerIntent =
  | Readonly<{ kind: "start_run"; text: string }>
  | Readonly<{ kind: "queue_input"; text: string }>
  | Readonly<{ kind: "withdraw"; inputId: string }>
  | Readonly<{ kind: "reject"; reason: "empty" | "run_active" }>;

export function interpretComposer(
  view: TuiViewState,
  text: string,
  options: Readonly<{ activeRunAcceptsInput: boolean }> = { activeRunAcceptsInput: true },
): ComposerIntent {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "reject", reason: "empty" };
  if (view.runStatus === "active" || view.waitingKind !== null) {
    if (!options.activeRunAcceptsInput) return { kind: "reject", reason: "run_active" };
    return { kind: "queue_input", text: trimmed };
  }
  if (view.runStatus === "waiting") return { kind: "reject", reason: "run_active" };
  return { kind: "start_run", text: trimmed };
}

/**
 * Closing an approval or question panel is a view action. It must never be
 * interpreted as an answer, a decision or a resume.
 */
export type PanelAction = "close" | "open";

export function panelActionKeepsWait(action: PanelAction): boolean {
  return action === "close" || action === "open";
}
