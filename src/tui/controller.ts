import type {
  CoordinatorResult,
  RuntimeCoordinator,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import { deriveView, interpretComposer, type TuiViewState } from "./view-model.ts";

/**
 * Bridges the Runtime coordinator to the TUI view. It holds only projection
 * state plus a draft; every authority decision stays inside the coordinator.
 */
export type TuiSessionDeps = Readonly<{
  coordinator: RuntimeCoordinator;
  getEvents: () => readonly InternalEvent[];
  getTodo: () => TodoList | null;
  nowUtc: () => string;
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
  let approvalCommandCounter = 0;

  function view(): TuiViewState {
    return deriveView({
      runStatus,
      safeCode,
      events: deps.getEvents(),
      todo: deps.getTodo(),
      pendingApproval: deps.coordinator.pendingApprovalView(),
      pendingQuestion: deps.coordinator.pendingQuestionView(),
      draft,
    });
  }

  function applyResult(result: CoordinatorResult): void {
    lastResult = result;
    runStatus = result.status;
    safeCode = result.safeCode;
  }

  async function submit(text: string): Promise<void> {
    const intent = interpretComposer(view(), text);
    draft = "";
    if (intent.kind === "reject") return;
    if (intent.kind === "queue_input") {
      await deps.coordinator.queueInput(intent.text);
      return;
    }
    if (intent.kind === "withdraw") return;
    runStatus = "active";
    safeCode = null;
    applyResult(await deps.coordinator.run(intent.text));
  }

  async function approve(): Promise<void> {
    const pending = deps.coordinator.pendingApprovalView();
    if (pending === null) return;
    approvalCommandCounter += 1;
    await deps.coordinator.replyApproval({
      commandId: `tui-approval-${approvalCommandCounter}`,
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      decision: "approved",
    });
    const settled = await deps.coordinator.settle();
    if (settled !== null) applyResult(settled);
  }

  async function deny(): Promise<void> {
    const pending = deps.coordinator.pendingApprovalView();
    if (pending === null) return;
    approvalCommandCounter += 1;
    await deps.coordinator.replyApproval({
      commandId: `tui-approval-${approvalCommandCounter}`,
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      decision: "denied",
    });
    const settled = await deps.coordinator.settle();
    if (settled !== null) applyResult(settled);
  }

  async function answer(text: string): Promise<void> {
    const pending = deps.coordinator.pendingQuestionView();
    if (pending === null) return;
    draft = "";
    approvalCommandCounter += 1;
    await deps.coordinator.submitUserInput({
      commandId: `tui-question-${approvalCommandCounter}`,
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: {
        kind: pending.answerType === "choice" ? "choice" : "text",
        optionIds: [text],
        text,
      },
    });
    const settled = await deps.coordinator.settle();
    if (settled !== null) applyResult(settled);
  }

  async function declineQuestion(): Promise<void> {
    const pending = deps.coordinator.pendingQuestionView();
    if (pending === null) return;
    approvalCommandCounter += 1;
    await deps.coordinator.declineQuestion({
      commandId: `tui-decline-${approvalCommandCounter}`,
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
    });
    const settled = await deps.coordinator.settle();
    if (settled !== null) applyResult(settled);
  }

  async function cancelRun(): Promise<void> {
    if (runStatus !== "active" && runStatus !== "waiting") return;
    approvalCommandCounter += 1;
    await deps.coordinator.cancelRun(`tui-cancel-${approvalCommandCounter}`);
    const settled = await deps.coordinator.settle();
    if (settled !== null) applyResult(settled);
  }

  return {
    view,
    submit,
    approve,
    deny,
    answer,
    declineQuestion,
    cancelRun,
    lastResult: () => lastResult,
  };
}
