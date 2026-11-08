import type {
  CoordinatorResult,
  QueueInputOutcome,
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
  initialEvents?: readonly InternalEvent[];
  canResumeSession?: (sessionId: string) => Promise<boolean>;
  /** Trusted composition corrects only the current fixed-route key reference. */
  correctCredential?: (secret: string) => Promise<boolean>;
}>;

export type TuiNavigationRequest =
  | Readonly<{ kind: "config"; page: "setup" | "model" }>
  | Readonly<{ kind: "session"; sessionId: string | null }>
  | Readonly<{ kind: "init" }>
  | Readonly<{ kind: "quit" }>;

export type TuiController = Readonly<{
  view: () => TuiViewState;
  submit: (text: string) => Promise<boolean | undefined>;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
  answer: (text: string) => Promise<void>;
  declineQuestion: () => Promise<void>;
  cancelRun: () => Promise<void>;
  close: () => Promise<void>;
  lastResult: () => CoordinatorResult | null;
  takeNavigationRequest: () => TuiNavigationRequest | null;
  closePanel: () => void;
  correctCredential?: (secret: string) => Promise<boolean>;
}>;

export function createTuiController(deps: TuiSessionDeps): TuiController {
  let runStatus: TuiViewState["runStatus"] = "idle";
  let safeCode: string | null = null;
  let lastResult: CoordinatorResult | null = null;
  let draft = "";
  let commandCounter = 0;
  let events: readonly InternalEvent[] = deps.initialEvents ?? [];
  let todo: TodoList = deriveTodo(emptyTodoList(), events);
  /**
   * The Run promise for the active Run. `coordinator.run` does not resolve while
   * the Run is suspended, so an approval or question reply must await this rather
   * than `settle()`, which only covers ResumeRun continuations.
   */
  let activeRun: Promise<CoordinatorResult> | null = null;
  /** Why the last answer was rejected, shown in the question panel. */
  let answerError: string | null = null;
  let navigation: TuiNavigationRequest | null = null;
  let localPanel: "help" | "session" | "credential" | null = null;
  let commandNotice: string | null = null;
  let checkingSession = false;
  let closing: Promise<void> | null = null;

  function rememberEvents(incoming: readonly InternalEvent[]): readonly InternalEvent[] {
    const known = new Set(events.map((event) => event.eventId));
    events = [...events, ...incoming.filter((event) => !known.has(event.eventId))];
    return events;
  }

  function applyResult(result: CoordinatorResult): void {
    lastResult = result;
    runStatus = result.status;
    safeCode = result.safeCode;
    rememberEvents(result.events);
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
    const live = deps.coordinator.currentRunProjection();
    return {
      ...deriveView({
        runStatus: live?.status ?? runStatus,
        safeCode,
        events: live === null ? events : rememberEvents(live.events),
        todo: todo.items.length === 0 ? null : todo,
        pendingApproval: deps.coordinator.pendingApprovalView(),
        pendingDisclosure: deps.coordinator.pendingDisclosureView(),
        pendingQuestion: deps.coordinator.pendingQuestionView(),
        answerError,
        draft,
      }),
      localPanel,
      commandNotice,
    };
  }

  async function submit(text: string): Promise<boolean | undefined> {
    if (closing !== null || navigation !== null || checkingSession) return;
    const intent = interpretComposer(view(), text);
    draft = "";
    commandNotice = null;
    if (intent.kind === "reject") {
      if (intent.reason !== "empty")
        commandNotice = {
          run_active: "Finish or cancel the current run first.",
          unknown_command: "Unknown command. Use /help.",
          invalid_command: "Invalid command. Use /help.",
        }[intent.reason];
      return;
    }
    if (intent.kind === "withdraw") return;
    if (intent.kind === "correct_credential") {
      if (deps.correctCredential === undefined)
        commandNotice = "Credential correction unavailable in this build.";
      else localPanel = "credential";
      return;
    }
    if (intent.kind === "resume_run") {
      const waiting = deps.coordinator.configurationWaitView();
      if (waiting === null) return;
      const resumed = await deps.coordinator.resumeRun({
        ...waiting,
        commandId: `tui-resume-${++commandCounter}`,
      });
      if (!resumed.ok) {
        commandNotice = `Run not resumed: ${resumed.code}`;
        return;
      }
      const continuation = await deps.coordinator.settle();
      if (continuation !== null) applyResult(continuation);
      return;
    }
    if (intent.kind === "queue_input") {
      let queued: QueueInputOutcome;
      try {
        queued = await deps.coordinator.queueInput(intent.text);
      } catch {
        draft = text;
        commandNotice = "Input not queued: storage unavailable";
        return false;
      }
      if (!queued.ok) {
        draft = text;
        commandNotice = `Input not queued: ${queued.code}`;
        return false;
      }
      return true;
    }
    if (intent.kind === "open_config" || intent.kind === "open_model") {
      navigation = { kind: "config", page: intent.kind === "open_model" ? "model" : "setup" };
      return;
    }
    if (intent.kind === "open_panel") {
      localPanel = intent.panel;
      return;
    }
    if (intent.kind === "switch_session") {
      checkingSession = true;
      try {
        if (intent.sessionId !== null && !(await deps.canResumeSession?.(intent.sessionId))) {
          commandNotice = "Session unavailable. Enter an existing session ID.";
          return;
        }
        navigation = { kind: "session", sessionId: intent.sessionId };
      } catch {
        commandNotice = "Session records could not be checked.";
      } finally {
        checkingSession = false;
      }
      return;
    }
    if (intent.kind === "cancel_run") {
      localPanel = null;
      await cancelRun();
      return;
    }
    if (intent.kind === "quit") {
      navigation = { kind: "quit" };
      return;
    }
    if (intent.kind === "project_init") {
      // The caller owns the scan and the write, because both need the workspace
      // adapter and the approval path.
      navigation = { kind: "init" };
      return;
    }
    localPanel = null;
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
    const disclosure = deps.coordinator.pendingDisclosureView();
    if (disclosure !== null) {
      commandCounter++;
      await deps.coordinator.replySensitiveDisclosure({
        ...disclosure,
        commandId: `tui-disclosure-${commandCounter}`,
        decision,
      });
      await settleActiveRun();
      return;
    }
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
    const status = view().runStatus;
    if (status !== "active" && status !== "waiting") return;
    commandCounter += 1;
    await deps.coordinator.cancelRun(`tui-cancel-${commandCounter}`);
    await settleActiveRun();
    const live = deps.coordinator.currentRunProjection();
    if (live === null && activeRun === null) {
      const finished = deps.coordinator.lastRunResult();
      if (finished !== null) applyResult(finished);
    }
  }

  function close(): Promise<void> {
    if (closing === null) {
      commandCounter += 1;
      closing = (async () => {
        try {
          await deps.coordinator.closeSession(`tui-close-${commandCounter}`);
        } finally {
          await settleActiveRun();
        }
      })();
    }
    return closing;
  }

  return {
    view,
    submit,
    approve: () => reply("approved"),
    deny: () => reply("denied"),
    answer,
    declineQuestion,
    cancelRun,
    close,
    lastResult: () => lastResult,
    correctCredential: async (secret) => {
      if (deps.coordinator.configurationWaitView() === null || closing !== null) return false;
      const saved = (await deps.correctCredential?.(secret)) ?? false;
      if (saved) {
        localPanel = null;
        commandNotice = "Key saved. Run remains waiting; use /resume.";
      }
      return saved;
    },
    closePanel: () => {
      localPanel = null;
      commandNotice = null;
    },
    takeNavigationRequest: () => {
      const requested = navigation;
      navigation = null;
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
