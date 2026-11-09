import type {
  CoordinatorResult,
  QueueInputOutcome,
  RuntimeCoordinator,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import { emptyTodoList, replaceTodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import { resolveAnswer } from "./answer-input.ts";
import type { McpPanelEntry } from "./mcp-panel.ts";
import type { SessionListEntry } from "./session-list.ts";
import { deriveView, interpretComposer, type TuiViewState } from "./view-model.ts";

/**
 * Bridges the Runtime coordinator to the TUI view. It holds only projection
 * state plus a draft; every authority decision stays inside the coordinator.
 */
export type SkillCatalogEntry = Readonly<{
  skillId: string;
  description: string;
  bytes: number;
}>;

export type TuiSessionDeps = Readonly<{
  coordinator: RuntimeCoordinator;
  /** This process's session id, used to mark the current row. */
  sessionId?: string;
  initialEvents?: readonly InternalEvent[];
  canResumeSession?: (sessionId: string) => Promise<boolean>;
  /** Trusted composition corrects only the current fixed-route key reference. */
  correctCredential?: (secret: string) => Promise<boolean>;
  /**
   * Workspace Skill catalog for the `/skills` panel. Absent means skills are
   * disabled; a failure is reported rather than shown as an empty catalog.
   */
  skillCatalog?: () => Promise<
    | Readonly<{ ok: true; skills: readonly SkillCatalogEntry[] }>
    | Readonly<{ ok: false; code: string }>
  >;
  /**
   * Read the declared MCP servers for the panel. Absent means the panel cannot
   * read configuration, which is reported rather than shown as an empty list.
   */
  mcpServers?: () => Promise<
    | Readonly<{ ok: true; servers: readonly McpPanelEntry[] }>
    | Readonly<{ ok: false; code: string }>
  >;
  /** Apply an MCP change. The caller owns the config store write. */
  mcpChange?: (change: {
    add?: McpPanelEntry;
    remove?: string;
  }) => Promise<
    | Readonly<{ ok: true; servers: readonly McpPanelEntry[] }>
    | Readonly<{ ok: false; code: string }>
  >;
  /** Session records on disk, for the list panel. */
  sessionCatalog?: Readonly<{
    list: () => Promise<
      | Readonly<{ ok: true; sessions: readonly Omit<SessionListEntry, "current">[] }>
      | Readonly<{ ok: false; code: string }>
    >;
    rename: (
      sessionId: string,
      title: string | null,
    ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>>;
    remove: (
      sessionId: string,
    ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>>;
  }>;
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
  addMcpServer: (entry: McpPanelEntry) => Promise<void>;
  removeMcpServer: (serverId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string | null) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
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
  let localPanel: "help" | "session" | "credential" | "skills" | "mcp" | "sessions" | null = null;
  /** Loaded once per panel open, so the view never performs I/O. */
  let skillCatalog: readonly SkillCatalogEntry[] | null = null;
  let skillCatalogError: string | null = null;
  let mcpServers: readonly McpPanelEntry[] | null = null;
  let mcpError: string | null = null;
  let mcpBusy = false;
  let sessionList: readonly SessionListEntry[] | null = null;
  let sessionListError: string | null = null;
  let sessionListBusy = false;
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

  /**
   * Load the Skill catalog for the panel.
   *
   * A failure is kept as a reason rather than rendered as an empty catalog: an empty
   * list would claim the workspace has no skills, which is a different fact.
   */
  async function loadSkillCatalog(): Promise<void> {
    const loader = deps.skillCatalog;
    if (loader === undefined) {
      skillCatalog = null;
      skillCatalogError = "skills are disabled";
      return;
    }
    try {
      const loaded = await loader();
      if (loaded.ok) {
        skillCatalog = loaded.skills;
        skillCatalogError = null;
        return;
      }
      skillCatalog = null;
      skillCatalogError = loaded.code;
    } catch {
      skillCatalog = null;
      skillCatalogError = "catalog_unavailable";
    }
  }
  /** Read the recorded sessions. A failure is a reason, not an empty catalog. */
  async function loadSessionList(): Promise<void> {
    const loader = deps.sessionCatalog;
    if (loader === undefined) {
      sessionList = null;
      sessionListError = "session records are not readable in this build";
      return;
    }
    try {
      const loaded = await loader.list();
      if (loaded.ok) {
        // The current session is marked here rather than by the store: only this
        // process knows which id it owns.
        sessionList = loaded.sessions.map((entry) => ({
          ...entry,
          current: entry.sessionId === deps.sessionId,
        }));
        sessionListError = null;
        return;
      }
      sessionList = null;
      sessionListError = loaded.code;
    } catch {
      sessionList = null;
      sessionListError = "session records could not be read";
    }
  }

  /**
   * Apply a session edit and re-read the list from disk.
   *
   * Re-reading rather than patching locally is what makes the panel show what the
   * directory actually contains after a rename or a delete.
   */
  async function changeSession(
    apply: () => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>>,
    successNotice: string,
  ): Promise<void> {
    if (sessionListBusy) return;
    sessionListBusy = true;
    commandNotice = null;
    try {
      const result = await apply();
      if (!result.ok) {
        sessionListError = result.code;
        return;
      }
      commandNotice = successNotice;
      await loadSessionList();
    } catch {
      sessionListError = "the change could not be saved";
    } finally {
      sessionListBusy = false;
    }
  }

  /** Read the declared MCP servers. A failure is kept as a reason, not an empty list. */
  async function loadMcpServers(): Promise<void> {
    const loader = deps.mcpServers;
    if (loader === undefined) {
      mcpServers = null;
      mcpError = "configuration is not readable in this build";
      return;
    }
    try {
      const loaded = await loader();
      if (loaded.ok) {
        mcpServers = loaded.servers;
        mcpError = null;
        return;
      }
      mcpServers = null;
      mcpError = loaded.code;
    } catch {
      mcpServers = null;
      mcpError = "configuration could not be read";
    }
  }

  /**
   * Apply an MCP edit. The list is re-read from the result rather than patched
   * locally, so the panel shows what the document actually contains.
   */
  async function changeMcp(change: { add?: McpPanelEntry; remove?: string }): Promise<void> {
    if (mcpBusy) return;
    const apply = deps.mcpChange;
    if (apply === undefined) {
      mcpError = "configuration is not writable in this build";
      return;
    }
    mcpBusy = true;
    commandNotice = null;
    try {
      const result = await apply(change);
      if (result.ok) {
        mcpServers = result.servers;
        mcpError = null;
        commandNotice = change.remove === undefined ? "server added" : "server removed";
      } else {
        mcpError = result.code;
      }
    } catch {
      mcpError = "configuration could not be saved";
    } finally {
      mcpBusy = false;
    }
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
      skillCatalog,
      skillCatalogError,
      mcpServers,
      mcpError,
      mcpBusy,
      sessionList,
      sessionListError,
      sessionListBusy,
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
      if (intent.panel === "skills") await loadSkillCatalog();
      if (intent.panel === "mcp") await loadMcpServers();
      if (intent.panel === "sessions") await loadSessionList();
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
    if (intent.kind === "rename_session") {
      await changeSession(
        async () =>
          (await deps.sessionCatalog?.rename(intent.sessionId, intent.title)) ?? {
            ok: false as const,
            code: "unavailable",
          },
        intent.title === null ? "title cleared" : "session renamed",
      );
      return;
    }
    if (intent.kind === "delete_session") {
      await changeSession(
        async () =>
          (await deps.sessionCatalog?.remove(intent.sessionId)) ?? {
            ok: false as const,
            code: "unavailable",
          },
        "session deleted",
      );
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
    const run =
      intent.skillId === undefined
        ? deps.coordinator.run(intent.text)
        : deps.coordinator.run(intent.text, { skillId: intent.skillId });
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
    addMcpServer: (entry) => changeMcp({ add: entry }),
    removeMcpServer: (serverId) => changeMcp({ remove: serverId }),
    renameSession: (sessionId, title) =>
      changeSession(
        async () =>
          (await deps.sessionCatalog?.rename(sessionId, title)) ?? {
            ok: false as const,
            code: "unavailable",
          },
        title === null ? "title cleared" : "session renamed",
      ),
    deleteSession: (sessionId) =>
      changeSession(
        async () =>
          (await deps.sessionCatalog?.remove(sessionId)) ?? {
            ok: false as const,
            code: "unavailable",
          },
        "session deleted",
      ),
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
