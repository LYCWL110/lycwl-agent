import type {
  CoordinatorResult,
  RuntimeCoordinator,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import { emptyTodoList, replaceTodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import { resolveAnswer } from "./answer-input.ts";
import { deriveView, interpretComposer, type TuiViewState } from "./view-model.ts";

/**
 * Bridges the Runtime coordinator to the TUI view. It holds only projection
 * state plus a draft; every authority decision stays inside the coordinator.
 */
export type TuiSessionDeps = Readonly<{
  coordinator: RuntimeCoordinator;
}>;

export type TuiController = Readonly<{
  view: () => TuiViewState;
  submit: (text: string) => Promise<void>;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
  answer: (text: string) => Promise<void>;
  declineQuestion: () => Promise<void>;
  cancelRun: () => Promise<void>;
  lastResult: () => CoordinatorResult | null;
  /**
   * True once when the user asked to open the provider browser. The caller
   * consumes it, because opening the browser needs the config store and vault.
   */
  takeConfigRequest: () => boolean;
}>;

export function createTuiController(deps: TuiSessionDeps): TuiController {
  let runStatus: TuiViewState["runStatus"] = "idle";
  let safeCode: string | null = null;
  let lastResult: CoordinatorResult | null = null;
  let draft = "";
  let commandCounter = 0;
  let events: readonly InternalEvent[] = [];
  let todo: TodoList = emptyTodoList();
  /**
   * The Run promise for the active Run. `coordinator.run` does not resolve while
   * the Run is suspended, so an approval or question reply must await this rather
   * than `settle()`, which only covers ResumeRun continuations.
   */
  let activeRun: Promise<CoordinatorResult> | null = null;
  /** Why the last answer was rejected, shown in the question panel. */
  let answerError: string | null = null;
  /** Set when the composer asked to open the provider browser. */
  let configRequested = false;

  function applyResult(result: CoordinatorResult): void {
    lastResult = result;
    runStatus = result.status;
    safeCode = result.safeCode;
    events = result.events;
    todo = deriveTodo(todo, result.events);
  }

  /**
   * Await the suspended Run after a reply. `settle()` returns null for approval
   * and question replies because it only resolves ResumeRun continuations, so
   * relying on it left the view stuck showing the wait after the user acted.
   */
  async function settleActiveRun(): Promise<void> {
    const run = activeRun;
    if (run === null) return;
    const result = await run;
    if (activeRun === run) activeRun = null;
    applyResult(result);
  }

  function view(): TuiViewState {
    return deriveView({
      runStatus,
      safeCode,
      events,
      todo: todo.items.length === 0 ? null : todo,
      pendingApproval: deps.coordinator.pendingApprovalView(),
      pendingQuestion: deps.coordinator.pendingQuestionView(),
      answerError,
      draft,
    });
  }

  async function submit(text: string): Promise<void> {
    const intent = interpretComposer(view(), text);
    draft = "";
    if (intent.kind === "reject" || intent.kind === "withdraw") return;
    if (intent.kind === "queue_input") {
      await deps.coordinator.queueInput(intent.text);
      return;
    }
    if (intent.kind === "open_config") {
      // The controller reports the request; the caller owns the browser because it
      // needs the config store and the vault, which the controller does not have.
      configRequested = true;
      return;
    }
    runStatus = "active";
    safeCode = null;
    const run = deps.coordinator.run(intent.text);
    activeRun = run;
    const result = await run;
    // Only clear when this is still the active Run: a later Run may have started.
    if (activeRun === run) activeRun = null;
    applyResult(result);
  }

  async function reply(decision: "approved" | "denied"): Promise<void> {
    const pending = deps.coordinator.pendingApprovalView();
    if (pending === null) return;
    commandCounter += 1;
    await deps.coordinator.replyApproval({
      commandId: `tui-approval-${commandCounter}`,
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      decision,
    });
    await settleActiveRun();
  }

  async function answer(text: string): Promise<void> {
    const pending = deps.coordinator.pendingQuestionView();
    if (pending === null) return;
    draft = "";
    commandCounter += 1;
    // Accept an option id or the label the panel showed. A rejected answer keeps
    // the question open and reports why, instead of failing silently.
    const resolved = resolveAnswer(
      {
        answerType: pending.answerType,
        multiple: pending.multiple,
        allowFreeText: pending.allowFreeText,
        options: pending.options,
      },
      text,
    );
    if (!resolved.ok) {
      answerError = resolved.detail;
      return;
    }
    answerError = null;
    const answerPayload = resolved.answer;
    await deps.coordinator.submitUserInput({
      commandId: `tui-question-${commandCounter}`,
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: answerPayload,
    });
    await settleActiveRun();
  }

  async function declineQuestion(): Promise<void> {
    const pending = deps.coordinator.pendingQuestionView();
    if (pending === null) return;
    commandCounter += 1;
    await deps.coordinator.declineQuestion({
      commandId: `tui-decline-${commandCounter}`,
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
    });
    await settleActiveRun();
  }

  async function cancelRun(): Promise<void> {
    if (runStatus !== "active" && runStatus !== "waiting") return;
    commandCounter += 1;
    await deps.coordinator.cancelRun(`tui-cancel-${commandCounter}`);
    await settleActiveRun();
  }

  return {
    view,
    submit,
    approve: () => reply("approved"),
    deny: () => reply("denied"),
    answer,
    declineQuestion,
    cancelRun,
    lastResult: () => lastResult,
    /** Consume a pending open-config request, if any. */
    takeConfigRequest: () => {
      const requested = configRequested;
      configRequested = false;
      return requested;
    },
  };
}

/**
 * Todo state is restored from the authoritative todo_replaced events rather than
 * trusting the model's message history.
 */
function deriveTodo(previous: TodoList, events: readonly InternalEvent[]): TodoList {
  let current = previous;
  for (const event of events) {
    if (event.payload.kind !== "todo_replaced") continue;
    const replaced = replaceTodoList(current, event.payload.items);
    if (replaced.ok) current = replaced.value;
  }
  return current;
}
