import type {
  CoordinatorResult,
  RuntimeCoordinator,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import { emptyTodoList, replaceTodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
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
    const answerPayload =
      pending.answerType === "choice"
        ? { kind: "choice" as const, optionIds: [text] }
        : pending.answerType === "confirmation"
          ? { kind: "confirmation" as const, confirmed: text.toLowerCase() === "yes" }
          : { kind: "text" as const, text };
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
