import type { CompactionArtifact } from "../../domain/context/compaction.ts";
import {
  type ContextBudget,
  conservativeEstimate,
  decideRequestFit,
} from "../../domain/context/context-budget.ts";
import {
  mergeTouchedPaths,
  type TouchedPath,
  touchedPaths,
} from "../../domain/context/touched-paths.ts";
import type { RunModelBinding } from "../../domain/model-request/run-binding.ts";
import { bindAttempt } from "../../domain/model-request/run-binding.ts";
import { emptyTodoList, replaceTodoList, type TodoList } from "../../domain/planning/todo.ts";
import {
  type AnswerFailure,
  type AskUserQuestion,
  type QuestionOutcome,
  questionOutcome,
  validateUserAnswer,
} from "../../domain/question/ask-user.ts";
import {
  consumeRunInput,
  emptyRunInputQueue,
  queueRunInput,
  type RunInputQueue,
} from "../../domain/run/input-queue.ts";
import {
  type CallFingerprint,
  type CallRecord,
  checkIdenticalCall,
  type ProgressDecision,
} from "../../domain/run/no-progress.ts";
import { addCompaction, addModelRound, createRunBudget } from "../../domain/run/run-budget.ts";
import { finishRun, type Run, resumeRun, startRun, waitRun } from "../../domain/run/run-state.ts";
import type { OwnedKeyRegistry } from "../../domain/security/owned-key-guard.ts";
import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type {
  ModelProvider,
  ProviderConversationItem,
  ProviderToolCall,
} from "../../ports/model-provider.ts";
import type { ToolExecutionRequest, ToolExecutor } from "../../ports/tool-executor.ts";
import {
  assertProtectedValue,
  guardToolResultText,
  ProtectedDeliveryError,
} from "../../services/security/guarded-delivery.ts";
import {
  estimateArtifactTokens,
  parseCompactionArtifact,
  prepareCompaction,
  validateArtifact,
} from "./compaction-service.ts";
import { retainRecentGroups } from "./conversation-rebuild.ts";
import type { EventInput, EventLog } from "./event-log.ts";
import type { InternalEvent } from "./internal-events.ts";
import { completeWithBoundedRetries } from "./model-attempts.ts";
import { executeToolCall, type ToolCallOutcome } from "./tool-call-execution.ts";

export type CoordinatorResult =
  | Readonly<{
      status: "completed" | "failed" | "cancelled";
      run: Run;
      events: readonly InternalEvent[];
      text: string | null;
      safeCode: string | null;
    }>
  | Readonly<{
      status: "waiting";
      run: Run;
      events: readonly InternalEvent[];
      text: null;
      safeCode: string;
    }>;

export type CheckpointWriter = Readonly<{
  /** Report an appended event; true means a checkpoint is now due. */
  noteEvent: (sessionId: string, event: InternalEvent) => boolean;
  write: (sessionId: string, events: readonly InternalEvent[]) => Promise<unknown>;
}>;

export type CoordinatorDependencies = Readonly<{
  provider: ModelProvider;
  tools: ToolExecutor;
  approvals: ApprovalGate;
  eventLog: EventLog;
  ids: IdentifierFactory;
  nowUtc: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * When true (default), a required approval suspends the Run and waits for a
   * matching replyApproval. When false, the injected ApprovalGate decides inline,
   * which is only appropriate for deterministic tests and future trusted UI
   * adapters that already hold the reply.
   */
  suspendOnApproval?: boolean;
  /**
   * Optional checkpoint store. Checkpoints accelerate replay and never replace
   * the event log; a checkpoint failure must not fail the Run.
   */
  checkpoints?: CheckpointWriter;
  /**
   * Harness-owned Provider key registry (C10). When present, tool result text and
   * final assistant text are checked before delivery; a match blocks the payload
   * instead of rewriting it.
   */
  ownedKeys?: OwnedKeyRegistry;
  /** Refresh protective copies before a new Run and each model attempt. */
  refreshOwnedKeys?: () => Promise<void>;
  /**
   * Sourced, untrusted material placed before the user's task, such as project
   * guidance. It is a separate user turn, never merged into the system prompt: a
   * repository document must not acquire the authority of application
   * configuration. Empty or absent means nothing is injected.
   */
  projectContext?: string;
  /**
   * Conversation rebuilt from earlier Runs in this Session. It is prepended to the
   * new task so a resumed Session continues with its history instead of starting
   * blank. Later Runs inherit the previous terminal Run's current conversation.
   */
  priorConversation?: readonly ProviderConversationItem[];
  /**
   * Resolve guidance for paths the Run has touched, before each model request.
   *
   * Called at a safe boundary with the accumulated touched paths, so a session that
   * reads `src/api/handler.ts` can pick up `src/api/AGENTS.md` without restarting.
   * The result is injected as a sourced untrusted turn, never as a system prompt.
   * Absent means guidance is fixed at the launch value.
   */
  resolveProjectGuidance?: (
    touched: readonly TouchedPath[],
  ) => Promise<Readonly<{ text: string; sources: readonly string[] }> | null>;
  /**
   * Context budget for this Run. When present, the coordinator estimates the prompt
   * before each request and compacts when it exceeds the trigger. When absent, no
   * budgeting or compaction happens.
   */
  contextBudget?: ContextBudget;
  /** A known history/capacity failure must stop before contacting the Provider. */
  preflightFailure?: "protocol_history_incompatible" | "context_capacity_insufficient";
  /**
   * Fixed Session identity. When present, every Run this coordinator starts
   * appends to the same Session event log, so a restart can replay the history.
   * Absent means this coordinator creates one Session identity for its lifetime.
   */
  sessionId?: string;
  /**
   * Fixed model route for every Run this coordinator starts (C03). When present it
   * is recorded once at Run start and the credential revision is bound per
   * attempt. When absent, no route event is written and no revision is bound.
   */
  runBinding?: RunModelBinding;
  /**
   * Resolve the current credential revision for the next unsent attempt. A
   * same-reference rotation applies here; a different reference is refused by
   * `bindAttempt` before any send.
   */
  resolveCredentialRevision?: () => Promise<number | null>;
}>;

export type QueueInputOutcome =
  | Readonly<{ ok: true; inputId: string | null }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_identity"
        | "invalid_text"
        | "input_too_long"
        | "queue_full"
        | "queue_units_exceeded"
        | "run_terminal"
        | "sequence_not_increasing";
    }>;

export type CancelRunOutcome =
  | Readonly<{ ok: true; duplicate: boolean }>
  | Readonly<{ ok: false; code: "invalid_identity" | "run_terminal" }>;

export type ReplyApprovalOutcome =
  | Readonly<{ ok: true; duplicate: boolean }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_identity"
        | "run_terminal"
        | "unknown_approval"
        | "tool_call_mismatch"
        | "stale_version"
        | "conflicting_reply"
        | "not_waiting_for_approval";
    }>;

export type ResumeRunOutcome =
  | Readonly<{ ok: true; duplicate: boolean }>
  | Readonly<{
      ok: false;
      code: "invalid_identity" | "run_terminal" | "not_waiting_for_configuration";
    }>;

export type PendingQuestionView = Readonly<{
  questionId: string;
  toolCallId: string;
  question: string;
  answerType: "choice" | "text" | "confirmation";
  options: readonly Readonly<{ id: string; label: string }>[];
  multiple: boolean;
  allowFreeText: boolean;
  requestVersion: number;
}>;

export type QuestionReplyOutcome =
  | Readonly<{ ok: true; duplicate: boolean }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_identity"
        | "run_terminal"
        | "not_waiting_for_question"
        | "unknown_question"
        | "tool_call_mismatch"
        | "stale_version"
        | AnswerFailure;
    }>;

export type PendingApprovalView = Readonly<{
  approvalId: string;
  toolCallId: string;
  toolName: string;
  requestVersion: number;
}>;

type PendingApproval = {
  toolCallId: string;
  approvalId: string;
  waitToken: string;
  requestVersion: number;
  call: ProviderToolCall;
  decision: "approved" | "denied" | null;
  commandIds: Set<string>;
  resolve: () => void;
};

type PendingQuestion = {
  toolCallId: string;
  questionId: string;
  waitToken: string;
  requestVersion: number;
  question: AskUserQuestion;
  call: ProviderToolCall;
  outcome: QuestionOutcome | null;
  commandIds: Set<string>;
  resolve: () => void;
};

type MutableRunContext = {
  run: Run;
  readonly sessionId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly events: InternalEvent[];
  budget: ReturnType<typeof createRunBudget>;
  lastEventId: string | null;
  conversation: ProviderConversationItem[];
  inputQueue: RunInputQueue;
  nextAcceptedSeq: number;
  taskRevision: number;
  cancelRequested: boolean;
  abortController: AbortController;
  stopSiblings: boolean;
  cancelCommandIds: Set<string>;
  cancelledDuring: "model_request" | "tool_execution" | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  resumeCommandIds: Set<string>;
  pendingResume: Promise<CoordinatorResult> | null;
  checkpointFailure: string | null;
  deliveryBlocked: boolean;
  deliveryBlockReason: "owned_key_detected" | "guard_failure" | null;
  todoList: TodoList;
  /** Fixed model route for this Run (C03); null when none was configured. */
  runBinding: RunModelBinding | null;
  /** Tool call fingerprints for no-progress detection, oldest first. */
  callHistory: CallRecord[];
  /** True once queued user input was consumed since the last recorded call. */
  newInputSinceLastCall: boolean;
  /** Paths this Run has touched, for scoped guidance refresh. */
  touchedPaths: readonly TouchedPath[];
  /** Guidance sources already injected, so a refresh appends only new ones. */
  guidanceSources: Set<string>;
  /** Guidance text currently injected, replaced rather than duplicated. */
  guidanceText: string | null;
};

export class RuntimeCoordinator {
  readonly #deps: CoordinatorDependencies;
  readonly #sessionId: string;
  #conversation: readonly ProviderConversationItem[];
  #activeContext: MutableRunContext | null = null;

  constructor(dependencies: CoordinatorDependencies) {
    this.#deps = dependencies;
    this.#sessionId = dependencies.sessionId ?? dependencies.ids.create();
    this.#conversation = [...(dependencies.priorConversation ?? [])];
  }

  /**
   * Durably accept ordinary supplementary input for the current Run. Arrival is
   * not authorization: it only updates task context at the next safe boundary.
   */
  async queueInput(text: string): Promise<QueueInputOutcome> {
    const context = this.#activeContext;
    if (context === null) return { ok: false, code: "run_terminal" };
    const acceptedSeq = context.nextAcceptedSeq;
    const queued = queueRunInput(context.inputQueue, {
      commandId: this.#deps.ids.create(),
      inputId: this.#deps.ids.create(),
      text,
      acceptedSeq,
      runState: context.run.state,
    });
    if (!queued.ok) return { ok: false, code: queued.code };
    context.inputQueue = queued.queue;
    if (queued.duplicate) return { ok: true, inputId: null };
    context.nextAcceptedSeq = acceptedSeq + 1;
    const item = queued.queue.items.at(-1);
    if (item === undefined) return { ok: true, inputId: null };
    await this.#record(context, "run_input_queued", {
      kind: "run_input_queued",
      inputId: item.inputId,
      text: item.text,
      acceptedSeq: item.acceptedSeq,
    });
    return { ok: true, inputId: item.inputId };
  }

  /**
   * Durably record a CancelRun command for the current Run. Cancellation never
   * undoes a side effect that already started; the loop stops before any further
   * dispatch and reports what was actually executing.
   */
  async cancelRun(commandId: string): Promise<CancelRunOutcome> {
    const context = this.#activeContext;
    if (commandId.length === 0) return { ok: false, code: "invalid_identity" };
    if (context === null) return { ok: false, code: "run_terminal" };
    if (context.cancelCommandIds.has(commandId)) {
      return { ok: true, duplicate: true };
    }
    if (
      context.run.state === "completed" ||
      context.run.state === "failed" ||
      context.run.state === "cancelled"
    ) {
      return { ok: false, code: "run_terminal" };
    }
    context.cancelCommandIds.add(commandId);
    await this.#record(context, "run_cancel_requested", {
      kind: "run_cancel_requested",
      commandId,
    });
    context.cancelRequested = true;
    context.abortController.abort();
    context.pendingApproval?.resolve();
    context.pendingQuestion?.resolve();
    await this.#deps.tools.cancelAll?.();
    return { ok: true, duplicate: false };
  }

  /** Session resources outlive completed Runs, but never a closed Session. */
  async closeSession(commandId: string): Promise<void> {
    const context = this.#activeContext;
    const cancelled = await this.cancelRun(commandId);
    if (!cancelled.ok) await this.#deps.tools.cancelAll?.();
    else if (
      context?.run.state === "waiting" &&
      (context.run.reason === "configuration" || context.run.reason === "recovery_review")
    ) {
      await this.#cancel(context);
      this.#activeContext = null;
    }
  }

  /**
   * Snapshot of current facts for a TUI; reading it performs no transition.
   */
  currentRunProjection(): Readonly<{
    status: Run["state"];
    events: readonly InternalEvent[];
  }> | null {
    const context = this.#activeContext;
    return context === null ? null : { status: context.run.state, events: context.events.slice() };
  }

  /** Reading a pending approval grants no authority. */
  pendingApprovalView(): PendingApprovalView | null {
    const pending = this.#activeContext?.pendingApproval;
    if (pending === null || pending === undefined) return null;
    return {
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      toolName: pending.call.toolName,
      requestVersion: pending.requestVersion,
    };
  }

  /**
   * Record an approval reply for the pending approval wait. A matching reply
   * resolves that wait directly; a duplicate commandId cannot decide twice.
   */
  async replyApproval(input: {
    commandId: string;
    approvalId: string;
    toolCallId: string;
    requestVersion: number;
    decision: "approved" | "denied";
  }): Promise<ReplyApprovalOutcome> {
    const context = this.#activeContext;
    if (input.commandId.length === 0 || input.approvalId.length === 0) {
      return { ok: false, code: "invalid_identity" };
    }
    if (context === null) return { ok: false, code: "run_terminal" };
    const pending = context.pendingApproval;
    if (pending === null) return { ok: false, code: "not_waiting_for_approval" };
    if (pending.commandIds.has(input.commandId)) {
      return { ok: true, duplicate: true };
    }
    if (pending.approvalId !== input.approvalId) {
      return { ok: false, code: "unknown_approval" };
    }
    if (pending.toolCallId !== input.toolCallId) {
      return { ok: false, code: "tool_call_mismatch" };
    }
    if (pending.requestVersion !== input.requestVersion) {
      return { ok: false, code: "stale_version" };
    }
    pending.commandIds.add(input.commandId);
    pending.decision = input.decision;
    pending.resolve();
    return { ok: true, duplicate: false };
  }

  /**
   * Read-only projection of the question the Run is currently waiting on.
   * Rendering or closing the panel changes nothing; only a reply does.
   */
  pendingQuestionView(): PendingQuestionView | null {
    const pending = this.#activeContext?.pendingQuestion;
    if (pending === null || pending === undefined) return null;
    const question = pending.question;
    const options = question.answerType === "choice" ? question.options : [];
    return {
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      question: question.question,
      answerType: question.answerType,
      options,
      multiple: question.answerType === "choice" ? question.multiple : false,
      allowFreeText: question.answerType === "choice" ? question.allowFreeText : false,
      requestVersion: pending.requestVersion,
    };
  }

  /** Submit a typed answer to the pending question. */
  async submitUserInput(input: {
    commandId: string;
    questionId: string;
    toolCallId: string;
    requestVersion: number;
    answer: unknown;
  }): Promise<QuestionReplyOutcome> {
    return this.#resolveQuestion(input, (question) => {
      const validated = validateUserAnswer(question, input.answer);
      if (!validated.ok) return { ok: false, code: validated.code };
      return { ok: true, outcome: questionOutcome("answered", validated.text) };
    });
  }

  /** Explicitly decline the pending question: a failed tool result, not approval. */
  async declineQuestion(input: {
    commandId: string;
    questionId: string;
    toolCallId: string;
    requestVersion: number;
  }): Promise<QuestionReplyOutcome> {
    return this.#resolveQuestion(input, () => ({
      ok: true,
      outcome: questionOutcome("declined", null),
    }));
  }

  /** Cancel only this question; this is not CancelRun. */
  async cancelQuestion(input: {
    commandId: string;
    questionId: string;
    toolCallId: string;
    requestVersion: number;
  }): Promise<QuestionReplyOutcome> {
    return this.#resolveQuestion(input, () => ({
      ok: true,
      outcome: questionOutcome("cancelled", null),
    }));
  }

  /** Report that no usable interaction channel exists for the question. */
  async markQuestionUnavailable(input: {
    commandId: string;
    questionId: string;
    toolCallId: string;
    requestVersion: number;
  }): Promise<QuestionReplyOutcome> {
    return this.#resolveQuestion(input, () => ({
      ok: true,
      outcome: questionOutcome("unavailable", null),
    }));
  }

  /** Closing the panel retains the wait; it is a view event only. */
  async closeQuestionView(questionId: string): Promise<{ ok: boolean }> {
    const context = this.#activeContext;
    if (context === null || context.pendingQuestion?.questionId !== questionId) {
      return { ok: false };
    }
    await this.#record(context, "question_view_closed", {
      kind: "question_view_closed",
      questionId,
    });
    return { ok: true };
  }

  async #resolveQuestion(
    input: {
      commandId: string;
      questionId: string;
      toolCallId: string;
      requestVersion: number;
    },
    decide: (
      question: AskUserQuestion,
    ) =>
      | Readonly<{ ok: true; outcome: QuestionOutcome }>
      | Readonly<{ ok: false; code: AnswerFailure }>,
  ): Promise<QuestionReplyOutcome> {
    const context = this.#activeContext;
    if (input.commandId.length === 0 || input.questionId.length === 0) {
      return { ok: false, code: "invalid_identity" };
    }
    if (context === null) return { ok: false, code: "run_terminal" };
    const pending = context.pendingQuestion;
    if (pending === null) return { ok: false, code: "not_waiting_for_question" };
    if (pending.commandIds.has(input.commandId)) return { ok: true, duplicate: true };
    if (pending.questionId !== input.questionId) {
      return { ok: false, code: "unknown_question" };
    }
    if (pending.toolCallId !== input.toolCallId) {
      return { ok: false, code: "tool_call_mismatch" };
    }
    if (pending.requestVersion !== input.requestVersion) {
      return { ok: false, code: "stale_version" };
    }
    const decided = decide(pending.question);
    if (!decided.ok) return { ok: false, code: decided.code };
    pending.commandIds.add(input.commandId);
    pending.outcome = decided.outcome;
    pending.resolve();
    return { ok: true, duplicate: false };
  }

  async run(input: string): Promise<CoordinatorResult> {
    const projectContext = this.#deps.projectContext;
    const context: MutableRunContext = {
      run: startRun(),
      sessionId: this.#sessionId,
      runId: this.#deps.ids.create(),
      correlationId: this.#deps.ids.create(),
      events: [],
      budget: createRunBudget(),
      lastEventId: null,
      conversation: [
        ...(projectContext === undefined ? [] : [{ kind: "user" as const, text: projectContext }]),
        ...this.#conversation,
        { kind: "user", text: input },
      ],
      inputQueue: emptyRunInputQueue(),
      nextAcceptedSeq: 1,
      taskRevision: 1,
      cancelRequested: false,
      abortController: new AbortController(),
      stopSiblings: false,
      cancelCommandIds: new Set<string>(),
      cancelledDuring: null,
      pendingApproval: null,
      pendingQuestion: null,
      resumeCommandIds: new Set<string>(),
      pendingResume: null,
      checkpointFailure: null,
      deliveryBlocked: false,
      deliveryBlockReason: null,
      todoList: emptyTodoList(),
      runBinding: this.#deps.runBinding ?? null,
      callHistory: [],
      newInputSinceLastCall: false,
      touchedPaths: [],
      guidanceSources: new Set<string>(),
      guidanceText: projectContext ?? null,
    };
    this.#activeContext = context;
    try {
      await this.#deps.refreshOwnedKeys?.();
      await this.#record(context, "run_started", { kind: "run_started", input });
      const binding = this.#deps.runBinding;
      if (binding !== undefined) {
        await this.#record(context, "run_model_binding", {
          kind: "run_model_binding",
          providerId: binding.providerId,
          modelId: binding.modelId,
          protocolId: binding.protocolId,
          adapterVersion: binding.adapterVersion,
          endpointFingerprint: binding.endpointFingerprint,
          catalogSnapshotId: binding.catalog.snapshotId,
          capabilitySnapshotId: binding.capabilities.snapshotId,
          credentialRef: binding.credential.credentialRef,
          credentialRevision: binding.credential.revision,
        });
      }
    } catch (error) {
      if (error instanceof ProtectedDeliveryError)
        return this.#blockDelivery(context, error.reason);
      this.#activeContext = null;
      throw error;
    }

    const result =
      this.#deps.preflightFailure === undefined
        ? await this.#loop(context)
        : await this.#fail(context, this.#deps.preflightFailure);
    if (context.run.state !== "waiting") this.#activeContext = null;
    return result;
  }

  /**
   * Resume a Run that is waiting for configuration or recovery review. A
   * matching approval/question reply resolves its own wait and does not need
   * this command.
   */
  async resumeRun(input: {
    commandId: string;
    waitToken: string;
    requestVersion: number;
  }): Promise<ResumeRunOutcome> {
    if (input.commandId.length === 0 || input.waitToken.length === 0) {
      return { ok: false, code: "invalid_identity" };
    }
    const context = this.#activeContext;
    if (context === null) return { ok: false, code: "run_terminal" };
    if (context.resumeCommandIds.has(input.commandId)) {
      return { ok: true, duplicate: true };
    }
    if (context.run.state !== "waiting" || context.run.reason !== "configuration") {
      return { ok: false, code: "not_waiting_for_configuration" };
    }
    if (
      context.run.waitToken !== input.waitToken ||
      context.run.requestVersion !== input.requestVersion
    ) {
      return { ok: false, code: "not_waiting_for_configuration" };
    }
    context.resumeCommandIds.add(input.commandId);
    const resumed = resumeRun(context.run);
    if (!resumed.ok) return { ok: false, code: "run_terminal" };
    context.run = resumed.value;
    await this.#record(context, "run_resumed", { kind: "run_resumed" });
    context.pendingResume = this.#loop(context);
    context.pendingResume.then(() => {
      if (context.run.state !== "waiting") this.#activeContext = null;
    });
    return { ok: true, duplicate: false };
  }

  /** Await the continuation queued by a previous resumeRun, if any. */
  async settle(): Promise<CoordinatorResult | null> {
    const pending = this.#activeContext?.pendingResume;
    if (pending === undefined) return null;
    return pending;
  }

  async #loop(context: MutableRunContext): Promise<CoordinatorResult> {
    try {
      while (context.run.state === "active") {
        if (context.cancelRequested) return this.#cancel(context);
        if (context.deliveryBlocked)
          return this.#blockDelivery(context, context.deliveryBlockReason ?? "owned_key_detected");

        const round = addModelRound(context.budget);
        if (!round.ok) return this.#fail(context, round.code);
        context.budget = round.value;

        // Refresh scoped guidance at the request boundary, before any send. A file
        // touched since the last round may bring a directory's AGENTS.md into scope.
        await this.#refreshGuidance(context);
        if (context.cancelRequested) return this.#cancel(context);

        // Budget and compaction happen at the same boundary: both must precede the
        // request, and a compaction that fails must leave the old context usable.
        const compaction = await this.#maybeCompact(context);
        if (compaction.kind === "stop") return compaction.result;

        const modelRequestId = this.#deps.ids.create();
        context.cancelledDuring = "model_request";
        const completion = await this.#completeWithRetries(context, modelRequestId);
        context.cancelledDuring = null;
        if (completion.kind === "terminal") return completion.result;
        if (context.cancelRequested) return this.#cancel(context);
        if (completion.kind === "waiting") return completion.result;
        if (completion.kind === "failed") return completion.result;
        await this.#deps.refreshOwnedKeys?.();
        if (this.#deps.ownedKeys !== undefined) {
          assertProtectedValue(this.#deps.ownedKeys, completion);
        }

        const toolCallIds = completion.toolCalls.map((call) => call.providerToolCallId);
        if (new Set(toolCallIds).size !== toolCallIds.length) {
          return this.#fail(context, "duplicate_provider_tool_call_id");
        }

        // The complete response (including tool names/arguments) passed the guard.
        const guardedCompletionText = completion.text;
        await this.#record(context, "model_response_validated", {
          kind: "model_response_validated",
          modelRequestId,
          attemptNo: completion.attemptNo,
          toolCallCount: completion.toolCalls.length,
          text: guardedCompletionText,
          toolCalls: completion.toolCalls,
        });

        // Section 8: the assistant turn belongs in the history. Without it the
        // following tool results answer calls the model never made, which is an
        // invalid protocol history and, with a strict adapter, a rejected request.
        context.conversation.push({
          kind: "assistant",
          text: guardedCompletionText,
          toolCalls: completion.toolCalls.map((call) => ({
            providerToolCallId: call.providerToolCallId,
            toolName: call.toolName,
            arguments: call.arguments,
          })),
        });

        // A pending queued input supersedes every undispatched call in this
        // response. The cancelled results must close the tool-call pairs *before*
        // the new user message is appended, otherwise the history would answer a
        // call after a new turn and become an illegal protocol sequence.
        const hasPendingInput = context.inputQueue.items.length > 0;
        if (hasPendingInput && completion.toolCalls.length > 0) {
          for (const call of completion.toolCalls) {
            context.conversation.push({
              kind: "tool_result",
              providerToolCallId: call.providerToolCallId,
              toolName: call.toolName,
              status: "cancelled",
              text: null,
            });
          }
        }

        const superseded = await this.#consumeQueuedInput(context);
        if (context.cancelRequested) return this.#cancel(context);
        if (superseded) {
          for (const call of completion.toolCalls) {
            await this.#record(context, "tool_call_cancelled", {
              kind: "tool_call_cancelled",
              toolCallId: this.#deps.ids.create(),
              providerToolCallId: call.providerToolCallId,
              toolName: call.toolName,
              reason: "user_input_superseded",
            });
          }
          continue;
        }

        if (completion.toolCalls.length === 0) {
          const finished = finishRun(context.run, "completed");
          if (!finished.ok) return this.#fail(context, finished.code);
          await this.#record(context, "run_completed", {
            kind: "run_completed",
            text: guardedCompletionText,
          });
          context.run = finished.value;
          return this.#result(context, "completed", guardedCompletionText, null);
        }

        for (const [index, call] of completion.toolCalls.entries()) {
          const callResult = await this.#executeCall(context, call);
          if (callResult.kind === "stop") return callResult.result;
          if (context.deliveryBlocked)
            return this.#blockDelivery(
              context,
              context.deliveryBlockReason ?? "owned_key_detected",
            );
          if (context.stopSiblings) {
            context.stopSiblings = false;
            for (const remaining of completion.toolCalls.slice(index + 1)) {
              this.#appendToolResult(
                context,
                remaining,
                "failed",
                "not_attempted: sibling mutation failed or was denied",
              );
              await this.#record(context, "tool_call_cancelled", {
                kind: "tool_call_cancelled",
                toolCallId: this.#deps.ids.create(),
                providerToolCallId: remaining.providerToolCallId,
                toolName: remaining.toolName,
                reason: "sibling_stopped",
              });
            }
            break;
          }
        }
      }
    } catch (error) {
      if (error instanceof ProtectedDeliveryError)
        return this.#blockDelivery(context, error.reason);
      return this.#fail(context, "unexpected_internal_error");
    }

    return this.#result(
      context,
      context.run.state === "completed"
        ? "completed"
        : context.run.state === "cancelled"
          ? "cancelled"
          : context.run.state === "waiting"
            ? "waiting"
            : "failed",
      null,
      "unexpected_run_state",
    );
  }

  /**
   * Consume queued input at the safe boundary before any dispatch. Returns true
   * when new input superseded the current response's undispatched calls.
   */
  async #consumeQueuedInput(context: MutableRunContext): Promise<boolean> {
    const pending = context.inputQueue.items;
    if (pending.length === 0) return false;
    const throughSeq = pending.at(-1)?.acceptedSeq ?? 0;
    const consumed = consumeRunInput(context.inputQueue, throughSeq, context.taskRevision);
    if (!consumed.ok) return false;
    context.inputQueue = consumed.queue;
    context.taskRevision = consumed.batch.taskRevision + 1;
    await this.#record(context, "run_input_batch_consumed", {
      kind: "run_input_batch_consumed",
      inputIds: consumed.batch.inputIds,
      throughSeq: consumed.batch.throughSeq,
      taskRevision: consumed.batch.taskRevision,
    });
    for (const item of pending) {
      context.conversation.push({ kind: "user", text: item.text });
    }
    // New user input is progress: it resets the identical-call counter for the
    // next call without touching accumulated failure history.
    context.newInputSinceLastCall = true;
    return true;
  }

  async #completeWithRetries(
    context: MutableRunContext,
    modelRequestId: string,
    /** Overrides the conversation; used by the auxiliary compaction request. */
    overrideConversation?: readonly ProviderConversationItem[],
  ): Promise<
    | Readonly<{
        kind: "completed";
        attemptNo: number;
        toolCalls: readonly ProviderToolCall[];
        text: string | null;
      }>
    | Readonly<{ kind: "terminal"; result: CoordinatorResult }>
    | Readonly<{ kind: "waiting"; result: CoordinatorResult }>
    | Readonly<{ kind: "failed"; result: CoordinatorResult }>
  > {
    const outcome = await completeWithBoundedRetries(
      {
        provider: this.#deps.provider,
        sleep: this.#deps.sleep ?? sleep,
        signal: context.abortController.signal,
        ...(this.#deps.resolveCredentialRevision === undefined
          ? {}
          : { resolveCredentialRevision: this.#deps.resolveCredentialRevision }),
        onRequestStarted: async (requestId, attemptNo, credentialRevision) => {
          await this.#deps.refreshOwnedKeys?.();
          if (this.#deps.ownedKeys !== undefined) {
            assertProtectedValue(
              this.#deps.ownedKeys,
              overrideConversation ?? context.conversation,
            );
          }
          // C03: an attempt may only advance the revision of the same credential
          // reference. A resolver that reports a different reference would mean a
          // silent identity change inside a Run, which must not be sent.
          const binding = context.runBinding;
          if (binding !== null && credentialRevision !== null) {
            const bound = bindAttempt(binding, {
              modelRequestId: requestId,
              attemptNo,
              credential: {
                credentialRef: binding.credential.credentialRef,
                revision: credentialRevision,
              },
            });
            if (!bound.ok) {
              // Nothing was sent; this is a configuration/identity refusal, not an
              // unknown outcome and not a retry.
              return { ok: false as const, safeCode: bound.code };
            }
          }
          await this.#record(context, "model_request_started", {
            kind: "model_request_started",
            modelRequestId: requestId,
            attemptNo,
            ...(overrideConversation === undefined
              ? {
                  includedInputIds: context.events.flatMap(({ payload }) =>
                    payload.kind === "run_input_batch_consumed" ? payload.inputIds : [],
                  ),
                }
              : {}),
            ...(credentialRevision === null ? {} : { credentialRevision }),
          });
          return { ok: true as const };
        },
        onRetryScheduled: async (input) => {
          await this.#record(context, "model_retry_scheduled", {
            kind: "model_retry_scheduled",
            ...input,
          });
        },
      },
      modelRequestId,
      overrideConversation ?? context.conversation,
    );

    if (outcome.kind === "cancelled" || context.cancelRequested) {
      return { kind: "terminal", result: await this.#cancel(context) };
    }
    if (outcome.kind === "completed") return outcome;
    if (outcome.kind === "authentication_failure") {
      const waitToken = this.#deps.ids.create();
      const waiting = waitRun(context.run, "configuration", waitToken, 1);
      if (!waiting.ok) {
        return { kind: "failed", result: await this.#fail(context, waiting.code) };
      }
      context.run = waiting.value;
      await this.#record(context, "run_waiting", {
        kind: "run_waiting",
        reason: "configuration",
        safeCode: outcome.safeCode,
        waitToken,
        requestVersion: 1,
      });
      return {
        kind: "waiting",
        result: {
          status: "waiting",
          run: context.run,
          events: [...context.events],
          text: null,
          safeCode: outcome.safeCode,
        },
      };
    }
    return {
      kind: "failed",
      result: await this.#fail(
        context,
        outcome.kind === "transient_retries_exhausted"
          ? "transient_retries_exhausted"
          : outcome.safeCode,
      ),
    };
  }

  /**
   * Session-scoped tool view. Todo state lives in the Run context and is
   * recorded as an event on every accepted replacement, so a restart restores
   * planning state from facts instead of trusting the model's message history.
   */
  #sessionTools(context: MutableRunContext): ToolExecutor {
    const base = this.#deps.tools;
    const preview = base.preview;
    return {
      getDefinition: (toolName) => base.getDefinition(toolName),
      requiresApproval: async (request) => (await base.requiresApproval?.(request)) ?? false,
      revalidateApproval: async (request) => (await base.revalidateApproval?.(request)) ?? true,
      discardApproval: (id) => base.discardApproval?.(id),
      ...(preview === undefined
        ? {}
        : { preview: (request: ToolExecutionRequest) => preview.call(base, request) }),
      execute: async (request) => {
        if (request.toolName !== "todo") return base.execute(request);
        const result = await base.execute(request);
        if (result.status !== "succeeded") return result;
        const items = (request.arguments as { items?: unknown } | null)?.items;
        const replaced = replaceTodoList(context.todoList, items);
        if (!replaced.ok) {
          return { status: "failed", safeCode: replaced.code, text: null };
        }
        context.todoList = replaced.value;
        await this.#record(context, "todo_replaced", {
          kind: "todo_replaced",
          revision: replaced.value.revision,
          items: replaced.value.items,
        });
        return result;
      },
    };
  }

  /**
   * Compare this call against recorded identical calls. Fingerprints are built
   * from the tool name/version, the canonicalized input and the resource version,
   * never from free error text or a regenerated id.
   */
  #checkProgress(
    context: MutableRunContext,
    call: Parameters<typeof executeToolCall>[1],
  ): ProgressDecision {
    const fingerprint: CallFingerprint = {
      toolName: call.toolName,
      toolVersion: this.#deps.tools.getDefinition(call.toolName)?.version ?? "unknown",
      normalizedInput: canonicalizeInput(call.arguments),
      // The coordinator does not read resources, so it cannot assert a version.
      // A null version means "unknown", which is stricter: the same input counts
      // as identical rather than being excused by a guess.
      resourceVersion: null,
    };
    return checkIdenticalCall({
      fingerprint,
      history: context.callHistory,
      hasNewUserInput: context.newInputSinceLastCall,
    });
  }

  /**
   * Replace the injected guidance turn when newly touched paths bring additional
   * sources into scope.
   *
   * The previous guidance turn is replaced in place rather than appended, so the
   * history does not accumulate a copy per round. A resolver failure keeps the
   * existing text: guidance is helpful context, and losing it mid-Run would be a
   * silent behaviour change.
   */
  async #refreshGuidance(context: MutableRunContext): Promise<void> {
    const resolver = this.#deps.resolveProjectGuidance;
    if (resolver === undefined || context.touchedPaths.length === 0) return;

    let resolved: Readonly<{ text: string; sources: readonly string[] }> | null;
    try {
      resolved = await resolver(context.touchedPaths);
    } catch {
      return;
    }
    if (resolved === null || resolved.text.length === 0) return;

    const hasNewSource = resolved.sources.some((source) => !context.guidanceSources.has(source));
    if (!hasNewSource) return;

    context.guidanceSources = new Set(resolved.sources);
    context.guidanceText = resolved.text;

    // Replace the first turn when it is the guidance block; otherwise insert one
    // before the task so the ordering contract stays "material, then task".
    const first = context.conversation[0];
    const isGuidanceTurn =
      first !== undefined && first.kind === "user" && first.text.includes("[project-guidance]");
    if (isGuidanceTurn) {
      context.conversation[0] = { kind: "user", text: resolved.text };
      return;
    }
    context.conversation.unshift({ kind: "user", text: resolved.text });
  }

  /**
   * Estimate the prompt and compact when it exceeds the trigger.
   *
   * Rules this respects:
   * - above the trigger but within P, an irreducible context is still sent;
   * - above P, nothing is sent;
   * - at most one regeneration per compaction, then fail;
   * - a failed compaction keeps the old context and does not fail the Run by itself.
   */
  async #maybeCompact(
    context: MutableRunContext,
  ): Promise<
    Readonly<{ kind: "continue" }> | Readonly<{ kind: "stop"; result: CoordinatorResult }>
  > {
    const budget = this.#deps.contextBudget;
    if (budget === undefined) return { kind: "continue" };

    const estimate = conservativeEstimate(estimateConversationTokens(context.conversation));
    const fit = decideRequestFit({
      budget,
      promptSize: estimate,
      historyIsReducible: context.conversation.length > 2,
    });

    if (fit.outcome === "send") return { kind: "continue" };
    if (fit.outcome === "cannot_send") {
      // Over P: refuse rather than send something oversized.
      return { kind: "stop", result: await this.#fail(context, "context_capacity_insufficient") };
    }

    // compact_first: at most two auxiliary attempts, matching C05.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prepared = prepareCompaction({
        conversation: context.conversation,
        fixedTokens: budget.fixed,
        auxiliaryBudgetTokens: budget.promptBudget - budget.output,
        recentBudget: budget.recentBudget,
        compactionsUsed: context.budget.compactions,
      });
      if (!prepared.ok) {
        await this.#record(context, "context_compaction_rejected", {
          kind: "context_compaction_rejected",
          reason:
            prepared.reason === "capacity_insufficient"
              ? "capacity_insufficient"
              : "invalid_artifact",
          detail: prepared.detail,
        });
        // Capacity failure is terminal for this request: sending the uncompacted
        // prompt would exceed the budget it just failed to fit.
        if (prepared.reason === "capacity_insufficient") {
          return {
            kind: "stop",
            result: await this.#fail(context, "context_capacity_insufficient"),
          };
        }
        return { kind: "continue" };
      }

      const planned = prepared.value.plan;
      const auxiliary = await this.#completeWithRetries(context, this.#deps.ids.create(), [
        { kind: "user", text: prepared.value.prompt },
      ]);
      if (auxiliary.kind !== "completed") {
        if (context.cancelRequested || auxiliary.kind === "terminal") {
          return { kind: "stop", result: auxiliary.result };
        }
        await this.#record(context, "context_compaction_rejected", {
          kind: "context_compaction_rejected",
          reason: "invalid_artifact",
          detail: "auxiliary request failed",
        });
        continue;
      }

      const parsed = parseCompactionArtifact(auxiliary.text);
      if (!parsed.ok) {
        await this.#record(context, "context_compaction_rejected", {
          kind: "context_compaction_rejected",
          reason: "invalid_artifact",
          detail: parsed.detail,
        });
        continue;
      }
      // The artifact must declare the groups it covered, or a caller cannot tell
      // what it replaced.
      const withSources: typeof parsed.artifact = {
        ...parsed.artifact,
        sourceMessageIds:
          parsed.artifact.sourceMessageIds.length === 0
            ? planned.summarizedGroupIds
            : parsed.artifact.sourceMessageIds,
      };

      const validated = validateArtifact({
        artifact: withSources,
        plan: planned,
        outputBudgetTokens: budget.summaryBudget,
        estimatedOutputTokens: estimateArtifactTokens(withSources),
        requiredSourceIds: planned.summarizedGroupIds,
        requiredConstraintIds: [],
      });
      if (!validated.ok) {
        await this.#record(context, "context_compaction_rejected", {
          kind: "context_compaction_rejected",
          reason: "invalid_artifact",
          detail: validated.detail,
        });
        continue;
      }

      // Publish: replace the summarised prefix with the artifact as a sourced turn.
      const recent = retainRecentGroups(context.conversation, planned.recentSuffixGroupIds.length);
      const artifactText = renderArtifact(validated.artifact);
      context.conversation = [
        { kind: "user", text: artifactText },
        ...(recent.length === 0 ? [] : recent),
      ];
      const round = addCompaction(context.budget);
      if (round.ok) context.budget = round.value;

      await this.#record(context, "context_compacted", {
        kind: "context_compacted",
        artifactSha256: hashText(JSON.stringify(validated.artifact)),
        summarizedGroupIds: planned.summarizedGroupIds,
        recentSuffixGroupIds: planned.recentSuffixGroupIds,
        sourceHighWaterSeq: planned.sourceHighWaterSeq,
        estimatedAuxiliaryTokens: planned.estimatedAuxiliaryTokens,
        artifactVersion: validated.artifact.schemaVersion,
        summaryText: artifactText,
      });
      return { kind: "continue" };
    }

    await this.#record(context, "context_compaction_rejected", {
      kind: "context_compaction_rejected",
      reason: "attempts_exhausted",
      detail: "two auxiliary attempts failed validation",
    });
    // Old context is retained; the request is attempted as-is so the Run is not
    // failed solely because summarisation did not work.
    return { kind: "continue" };
  }

  async #executeCall(
    context: MutableRunContext,
    call: Parameters<typeof executeToolCall>[1],
  ): Promise<
    Readonly<{ kind: "continue" }> | Readonly<{ kind: "stop"; result: CoordinatorResult }>
  > {
    if (context.run.state !== "active") {
      return { kind: "stop", result: await this.#fail(context, "run_not_active") };
    }
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }

    // No-progress check happens before dispatch: a blocked call is never executed,
    // so this cannot replay a side effect or exempt any budget.
    const progress = this.#checkProgress(context, call);
    if (progress.kind === "block") {
      const waitToken = this.#deps.ids.create();
      const waiting = waitRun(context.run, "recovery_review", waitToken, 1);
      if (!waiting.ok) {
        return { kind: "stop", result: await this.#fail(context, waiting.code) };
      }
      context.run = waiting.value;
      await this.#record(context, "no_progress_detected", {
        kind: "no_progress_detected",
        decision: "block",
        detail: progress.detail,
        toolName: call.toolName,
      });
      await this.#record(context, "run_waiting", {
        kind: "run_waiting",
        reason: "recovery",
        safeCode: "no_progress",
        waitToken,
        requestVersion: 1,
      });
      return {
        kind: "stop",
        result: this.#result(context, "waiting", null, "no_progress"),
      };
    }
    if (progress.kind === "warn") {
      // Feedback only: the call still proceeds under its normal approval policy.
      await this.#record(context, "no_progress_detected", {
        kind: "no_progress_detected",
        decision: "warn",
        detail: progress.detail,
        toolName: call.toolName,
      });
    }

    context.cancelledDuring = "tool_execution";
    const outcome = await executeToolCall(
      {
        tools: this.#sessionTools(context),
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
        signal: context.abortController.signal,
        deferApprovals: this.#deps.suspendOnApproval ?? false,
        deferQuestions: this.#deps.suspendOnApproval ?? false,
        ...(this.#deps.ownedKeys === undefined ? {} : { ownedKeys: this.#deps.ownedKeys }),
        ...(this.#deps.refreshOwnedKeys === undefined
          ? {}
          : { refreshOwnedKeys: this.#deps.refreshOwnedKeys }),
        onEvent: async (type, payload) => {
          await this.#record(context, type, payload as InternalEvent["payload"]);
        },
      },
      call,
    );
    context.cancelledDuring = null;
    if ("deliveryBlocked" in outcome && outcome.deliveryBlocked) {
      context.deliveryBlocked = true;
      context.deliveryBlockReason = outcome.deliveryBlockReason ?? "owned_key_detected";
    }

    if (outcome.kind === "unknown")
      this.#appendToolResult(context, call, "outcome_unknown", outcome.safeCode);
    if (context.cancelRequested && outcome.kind !== "continue")
      return { kind: "stop", result: await this.#cancel(context) };
    if (outcome.kind === "waiting") {
      return this.#awaitApproval(context, outcome);
    }
    if (outcome.kind === "question_waiting") {
      return this.#awaitQuestion(context, outcome);
    }
    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    this.#appendToolResult(context, call, outcome.status, outcome.text);
    context.stopSiblings =
      outcome.status !== "succeeded" &&
      this.#deps.tools.getDefinition(call.toolName)?.sideEffectClass === "filesystem_mutation";
    // Record the fingerprint after the fact so the next identical call is compared
    // against a real result rather than an intention.
    context.callHistory.push({
      fingerprint: {
        toolName: call.toolName,
        toolVersion: this.#deps.tools.getDefinition(call.toolName)?.version ?? "unknown",
        normalizedInput: canonicalizeInput(call.arguments),
        resourceVersion: null,
      },
      status: outcome.status,
      failure: null,
    });
    context.touchedPaths = mergeTouchedPaths(
      context.touchedPaths,
      touchedPaths(call.toolName, call.arguments),
    );
    context.newInputSinceLastCall = false;
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    return { kind: "continue" };
  }

  /**
   * Suspend the Run on a pending approval. A matching ReplyApproval resolves this
   * wait directly; no second ResumeRun is required.
   */
  async #awaitApproval(
    context: MutableRunContext,
    waiting: Extract<ToolCallOutcome, { kind: "waiting" }>,
  ): Promise<
    Readonly<{ kind: "continue" }> | Readonly<{ kind: "stop"; result: CoordinatorResult }>
  > {
    const wait = waitRun(context.run, "approval", waiting.waitToken, waiting.requestVersion);
    if (!wait.ok) {
      return { kind: "stop", result: await this.#fail(context, wait.code) };
    }
    context.run = wait.value;
    await this.#record(context, "run_waiting", {
      kind: "run_waiting",
      reason: "approval",
      safeCode: "approval_required",
      waitToken: waiting.waitToken,
      requestVersion: waiting.requestVersion,
    });

    const decision = await new Promise<"approved" | "denied" | null>((resolve) => {
      context.pendingApproval = {
        toolCallId: waiting.toolCallId,
        approvalId: waiting.approvalId,
        waitToken: waiting.waitToken,
        requestVersion: waiting.requestVersion,
        call: waiting.call,
        decision: null,
        commandIds: new Set<string>(),
        resolve: () => resolve(context.pendingApproval?.decision ?? null),
      };
    });

    const pending = context.pendingApproval;
    context.pendingApproval = null;
    if (pending === null) {
      return { kind: "stop", result: await this.#fail(context, "approval_wait_lost") };
    }

    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    if (decision === null) {
      return { kind: "stop", result: await this.#fail(context, "approval_wait_lost") };
    }

    const resumed = resumeRun(context.run);
    if (!resumed.ok) {
      return { kind: "stop", result: await this.#fail(context, resumed.code) };
    }
    context.run = resumed.value;

    await this.#record(context, "approval_decided", {
      kind: "approval_decided",
      approvalId: pending.approvalId,
      toolCallId: pending.toolCallId,
      decision,
    });

    const outcome = await executeToolCall(
      {
        tools: this.#sessionTools(context),
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
        signal: context.abortController.signal,
        deferApprovals: this.#deps.suspendOnApproval ?? false,
        ...(this.#deps.ownedKeys === undefined ? {} : { ownedKeys: this.#deps.ownedKeys }),
        ...(this.#deps.refreshOwnedKeys === undefined
          ? {}
          : { refreshOwnedKeys: this.#deps.refreshOwnedKeys }),
        onEvent: async (type, payload) => {
          await this.#record(context, type, payload as InternalEvent["payload"]);
        },
      },
      pending.call,
      {
        toolCallId: pending.toolCallId,
        approvalId: pending.approvalId,
        waitToken: pending.waitToken,
        requestVersion: pending.requestVersion,
        decision,
      },
    );
    if ("deliveryBlocked" in outcome && outcome.deliveryBlocked) {
      context.deliveryBlocked = true;
      context.deliveryBlockReason = outcome.deliveryBlockReason ?? "owned_key_detected";
    }

    if (outcome.kind === "unknown")
      this.#appendToolResult(context, pending.call, "outcome_unknown", outcome.safeCode);
    if (context.cancelRequested && outcome.kind !== "continue")
      return { kind: "stop", result: await this.#cancel(context) };
    if (outcome.kind === "waiting") return this.#awaitApproval(context, outcome);
    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "question_waiting") {
      return { kind: "stop", result: await this.#fail(context, "approval_wait_repeated") };
    }
    this.#appendToolResult(context, pending.call, outcome.status, outcome.text);
    context.stopSiblings =
      outcome.status !== "succeeded" &&
      this.#deps.tools.getDefinition(pending.call.toolName)?.sideEffectClass ===
        "filesystem_mutation";
    context.callHistory.push({
      fingerprint: {
        toolName: pending.call.toolName,
        toolVersion: this.#deps.tools.getDefinition(pending.call.toolName)?.version ?? "unknown",
        normalizedInput: canonicalizeInput(pending.call.arguments),
        resourceVersion: null,
      },
      status: outcome.status,
      failure: null,
    });
    context.touchedPaths = mergeTouchedPaths(
      context.touchedPaths,
      touchedPaths(pending.call.toolName, pending.call.arguments),
    );
    context.newInputSinceLastCall = false;
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    return { kind: "continue" };
  }

  /**
   * Suspend the Run on a pending ask_user question. Only a matching
   * SubmitUserInput answers it; decline/cancel/unavailable are separate.
   */
  async #awaitQuestion(
    context: MutableRunContext,
    waiting: Extract<ToolCallOutcome, { kind: "question_waiting" }>,
  ): Promise<
    Readonly<{ kind: "continue" }> | Readonly<{ kind: "stop"; result: CoordinatorResult }>
  > {
    const wait = waitRun(context.run, "user_input", waiting.waitToken, waiting.requestVersion);
    if (!wait.ok) {
      return { kind: "stop", result: await this.#fail(context, wait.code) };
    }
    context.run = wait.value;
    await this.#record(context, "run_waiting", {
      kind: "run_waiting",
      reason: "user_input",
      safeCode: "question_pending",
      waitToken: waiting.waitToken,
      requestVersion: waiting.requestVersion,
    });

    const answered = await new Promise<QuestionOutcome | null>((resolve) => {
      context.pendingQuestion = {
        toolCallId: waiting.toolCallId,
        questionId: waiting.questionId,
        waitToken: waiting.waitToken,
        requestVersion: waiting.requestVersion,
        question: waiting.question,
        call: waiting.call,
        outcome: null,
        commandIds: new Set<string>(),
        resolve: () => resolve(context.pendingQuestion?.outcome ?? null),
      };
    });

    const pending = context.pendingQuestion;
    context.pendingQuestion = null;
    if (pending === null) {
      return { kind: "stop", result: await this.#fail(context, "question_wait_lost") };
    }
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    if (answered === null) {
      return { kind: "stop", result: await this.#fail(context, "question_wait_lost") };
    }

    const resumed = resumeRun(context.run);
    if (!resumed.ok) {
      return { kind: "stop", result: await this.#fail(context, resumed.code) };
    }
    context.run = resumed.value;

    const outcome = await executeToolCall(
      {
        tools: this.#sessionTools(context),
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
        onEvent: async (type, payload) => {
          await this.#record(context, type, payload as InternalEvent["payload"]);
        },
      },
      pending.call,
      {
        toolCallId: pending.toolCallId,
        questionId: pending.questionId,
        waitToken: pending.waitToken,
        requestVersion: pending.requestVersion,
        outcome: answered,
      },
    );

    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "waiting" || outcome.kind === "question_waiting") {
      return { kind: "stop", result: await this.#fail(context, "question_wait_repeated") };
    }
    this.#appendToolResult(context, pending.call, outcome.status, outcome.text);
    context.callHistory.push({
      fingerprint: {
        toolName: pending.call.toolName,
        toolVersion: this.#deps.tools.getDefinition(pending.call.toolName)?.version ?? "unknown",
        normalizedInput: canonicalizeInput(pending.call.arguments),
        resourceVersion: null,
      },
      status: outcome.status,
      failure: null,
    });
    context.touchedPaths = mergeTouchedPaths(
      context.touchedPaths,
      touchedPaths(pending.call.toolName, pending.call.arguments),
    );
    context.newInputSinceLastCall = false;
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    return { kind: "continue" };
  }

  #appendToolResult(
    context: MutableRunContext,
    call: ProviderToolCall,
    status: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown",
    text: string | null,
  ): void {
    // C10: a blocked tool result keeps its real status but its text never
    // reaches model context. Blocking is not evidence of non-execution.
    const registry = this.#deps.ownedKeys;
    const delivery =
      registry === undefined
        ? { status, text, deliveryBlocked: false as const }
        : guardToolResultText(registry, status, text);
    if (delivery.deliveryBlocked) {
      context.deliveryBlocked = true;
      context.deliveryBlockReason = delivery.reason;
    }
    context.conversation.push({
      kind: "tool_result",
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      status,
      text: delivery.text,
    });
  }

  async #record(
    context: MutableRunContext,
    type: InternalEvent["type"],
    payload: InternalEvent["payload"],
  ): Promise<void> {
    await this.#deps.refreshOwnedKeys?.();
    const input: EventInput = {
      sessionId: context.sessionId,
      runId: context.runId,
      type,
      correlationId: context.correlationId,
      causationId: context.lastEventId,
      timestampUtc: this.#deps.nowUtc(),
      payload,
    };
    if (this.#deps.ownedKeys !== undefined) assertProtectedValue(this.#deps.ownedKeys, input);
    const event = await this.#deps.eventLog.append(input);
    context.events.push(event);
    context.lastEventId = event.eventId;
    await this.#maybeCheckpoint(context, event);
  }

  /**
   * Checkpoint after the authoritative event write. A checkpoint failure is
   * recorded as a diagnostic fact only: it must never fail the Run or pretend
   * the event was not written.
   */
  async #maybeCheckpoint(context: MutableRunContext, event: InternalEvent): Promise<void> {
    const store = this.#deps.checkpoints;
    if (store === undefined) return;
    let due: boolean;
    try {
      due = store.noteEvent(context.sessionId, event);
    } catch {
      context.checkpointFailure = "checkpoint_counter_failed";
      return;
    }
    if (!due) return;
    try {
      await store.write(context.sessionId, context.events);
    } catch {
      context.checkpointFailure = "checkpoint_write_failed";
    }
  }

  async #cancel(context: MutableRunContext): Promise<CoordinatorResult> {
    if (context.run.state === "cancelled")
      return this.#result(context, "cancelled", null, "run_cancelled");
    const outstanding = new Map<string, ProviderToolCall>();
    for (const item of context.conversation) {
      if (item.kind === "assistant")
        for (const call of item.toolCalls) outstanding.set(call.providerToolCallId, call);
      else if (item.kind === "tool_result") outstanding.delete(item.providerToolCallId);
    }
    const terminal = new Set<string>();
    for (const { payload } of context.events) {
      if (
        payload.kind === "tool_execution_finished" ||
        payload.kind === "tool_execution_denied" ||
        payload.kind === "tool_call_cancelled"
      )
        terminal.add(payload.toolCallId);
    }
    for (const { payload } of [...context.events]) {
      if (payload.kind !== "tool_call_received") continue;
      this.#deps.tools.discardApproval?.(payload.toolCallId);
      if (terminal.has(payload.toolCallId)) continue;
      await this.#record(context, "tool_call_cancelled", {
        kind: "tool_call_cancelled",
        toolCallId: payload.toolCallId,
        providerToolCallId: payload.providerToolCallId,
        toolName: payload.toolName,
        reason: "run_cancelled",
      });
    }
    const cancelledCalls = new Set(
      context.events
        .slice(
          context.events.findLastIndex(
            ({ payload }) => payload.kind === "model_response_validated",
          ),
        )
        .flatMap(({ payload }) =>
          payload.kind === "tool_call_cancelled" && payload.providerToolCallId !== undefined
            ? [payload.providerToolCallId]
            : [],
        ),
    );
    for (const call of outstanding.values()) {
      if (!cancelledCalls.has(call.providerToolCallId)) {
        await this.#record(context, "tool_call_cancelled", {
          kind: "tool_call_cancelled",
          toolCallId: this.#deps.ids.create(),
          providerToolCallId: call.providerToolCallId,
          toolName: call.toolName,
          reason: "run_cancelled",
        });
      }
      this.#appendToolResult(context, call, "cancelled", "not_attempted: run cancelled");
    }
    const finished = finishRun(context.run, "cancelled");
    if (!finished.ok) return this.#fail(context, finished.code);
    context.run = finished.value;
    await this.#record(context, "run_cancelled", {
      kind: "run_cancelled",
      safeCode: "run_cancelled",
    });
    return this.#result(context, "cancelled", null, "run_cancelled");
  }

  async #fail(context: MutableRunContext, safeCode: string): Promise<CoordinatorResult> {
    const finished = finishRun(context.run, "failed");
    if (finished.ok) {
      context.run = finished.value;
      await this.#record(context, "run_failed", { kind: "run_failed", safeCode });
    }
    return this.#result(context, "failed", null, safeCode);
  }

  async #blockDelivery(
    context: MutableRunContext,
    reason: "owned_key_detected" | "guard_failure",
  ): Promise<CoordinatorResult> {
    context.deliveryBlocked = true;
    const waitToken = this.#deps.ids.create();
    const waiting = waitRun(context.run, "recovery_review", waitToken, 1);
    if (waiting.ok) context.run = waiting.value;
    try {
      await this.#record(context, "tool_result_delivery_blocked", {
        kind: "tool_result_delivery_blocked",
        reason,
      });
      await this.#record(context, "run_waiting", {
        kind: "run_waiting",
        reason: "recovery",
        safeCode: "protected_delivery_blocked",
        waitToken,
        requestVersion: 1,
      });
    } catch (error) {
      // Short keys may collide with even the safe diagnostic vocabulary.
      // Withhold that record too; never fall back to unguarded persistence.
      if (!(error instanceof ProtectedDeliveryError)) throw error;
    }
    return this.#result(context, "waiting", null, "protected_delivery_blocked");
  }

  #result(
    context: MutableRunContext,
    status: "completed" | "failed" | "cancelled" | "waiting",
    text: string | null,
    safeCode: string | null,
  ): CoordinatorResult {
    if (status !== "waiting") {
      // Carry the actual conversation, including tool pairs and compaction.
      // Current project guidance is injected afresh at the next Run boundary.
      const [first, ...rest] = context.conversation;
      this.#conversation =
        first?.kind === "user" &&
        context.guidanceText !== null &&
        first.text === context.guidanceText
          ? rest
          : [...context.conversation];
    }
    return {
      status,
      run: context.run,
      events: [...context.events],
      text,
      safeCode,
    } as CoordinatorResult;
  }
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/**
 * Canonicalize tool arguments for fingerprinting: object keys are sorted so key
 * order cannot make two identical calls look different. This is a comparison
 * canonicalization, not a validation.
 */
function canonicalizeInput(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Rough conversation size, matching the per-message estimator used elsewhere. */
function estimateConversationTokens(conversation: readonly ProviderConversationItem[]): number {
  let total = 0;
  for (const item of conversation) {
    if (item.kind === "user") {
      total += Math.ceil(item.text.length / 4);
      continue;
    }
    if (item.kind === "assistant") {
      total += Math.ceil((item.text ?? "").length / 4);
      for (const call of item.toolCalls) {
        total += Math.ceil(JSON.stringify(call.arguments ?? {}).length / 4);
      }
      continue;
    }
    total += Math.ceil((item.text ?? "").length / 4);
  }
  return total;
}

/**
 * Render the artifact as the replacement turn.
 *
 * The text is labelled as a summary so the model can distinguish it from the
 * original messages, and evidence-free claims are marked unverified rather than
 * presented as established facts.
 */
function renderArtifact(artifact: CompactionArtifact): string {
  const lines = [
    "[context-summary]",
    "note=this replaces earlier turns; claims without evidence are unverified",
    `coverage=${artifact.coverage.fromSeq}..${artifact.coverage.toSeq}`,
    `goal=${artifact.goal}`,
  ];
  for (const claim of artifact.completedClaims) {
    const verified = claim.evidenceRefs.length > 0 ? "verified" : "unverified";
    lines.push(`- claim(${verified}): ${claim.text}`);
  }
  for (const reason of artifact.blockedReasons) lines.push(`- blocked: ${reason}`);
  for (const action of artifact.nextActions) lines.push(`- next: ${action}`);
  for (const file of artifact.fileReferences) lines.push(`- file: ${file}`);
  return lines.join("\n");
}

function hashText(text: string): string {
  // Deterministic, non-cryptographic digest for event correlation only. The
  // authoritative integrity check is the event hash chain, not this value.
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}
