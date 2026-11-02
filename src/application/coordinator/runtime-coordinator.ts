import {
  consumeRunInput,
  emptyRunInputQueue,
  queueRunInput,
  type RunInputQueue,
} from "../../domain/run/input-queue.ts";
import { addModelRound, createRunBudget } from "../../domain/run/run-budget.ts";
import { finishRun, type Run, resumeRun, startRun, waitRun } from "../../domain/run/run-state.ts";
import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type {
  ModelProvider,
  ProviderConversationItem,
  ProviderToolCall,
} from "../../ports/model-provider.ts";
import type { ToolExecutor } from "../../ports/tool-executor.ts";
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
  cancelCommandIds: Set<string>;
  cancelledDuring: "model_request" | "tool_execution" | null;
  pendingApproval: PendingApproval | null;
  resumeCommandIds: Set<string>;
  pendingResume: Promise<CoordinatorResult> | null;
};

export class RuntimeCoordinator {
  readonly #deps: CoordinatorDependencies;
  #activeContext: MutableRunContext | null = null;

  constructor(dependencies: CoordinatorDependencies) {
    this.#deps = dependencies;
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
    return { ok: true, duplicate: false };
  }

  /**
   * Read-only projection of the approval the Run is currently waiting on. A TUI
   * renders this and submits replyApproval; it grants no authority by itself.
   */
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

  async run(input: string): Promise<CoordinatorResult> {
    const context: MutableRunContext = {
      run: startRun(),
      sessionId: this.#deps.ids.create(),
      runId: this.#deps.ids.create(),
      correlationId: this.#deps.ids.create(),
      events: [],
      budget: createRunBudget(),
      lastEventId: null,
      conversation: [{ kind: "user", text: input }],
      inputQueue: emptyRunInputQueue(),
      nextAcceptedSeq: 1,
      taskRevision: 1,
      cancelRequested: false,
      cancelCommandIds: new Set<string>(),
      cancelledDuring: null,
      pendingApproval: null,
      resumeCommandIds: new Set<string>(),
      pendingResume: null,
    };
    await this.#record(context, "run_started", { kind: "run_started", input });
    this.#activeContext = context;

    const result = await this.#loop(context);
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

        const round = addModelRound(context.budget);
        if (!round.ok) return this.#fail(context, round.code);
        context.budget = round.value;

        const modelRequestId = this.#deps.ids.create();
        context.cancelledDuring = "model_request";
        const completion = await this.#completeWithRetries(context, modelRequestId);
        context.cancelledDuring = null;
        if (context.cancelRequested) return this.#cancel(context);
        if (completion.kind === "terminal") return completion.result;
        if (completion.kind === "waiting") return completion.result;
        if (completion.kind === "failed") return completion.result;

        const toolCallIds = completion.toolCalls.map((call) => call.providerToolCallId);
        if (new Set(toolCallIds).size !== toolCallIds.length) {
          return this.#fail(context, "duplicate_provider_tool_call_id");
        }

        await this.#record(context, "model_response_validated", {
          kind: "model_response_validated",
          modelRequestId,
          attemptNo: completion.attemptNo,
          toolCallCount: completion.toolCalls.length,
          text: completion.text,
        });

        const superseded = await this.#consumeQueuedInput(context);
        if (context.cancelRequested) return this.#cancel(context);
        if (superseded) {
          for (const call of completion.toolCalls) {
            await this.#record(context, "tool_call_cancelled", {
              kind: "tool_call_cancelled",
              toolCallId: this.#deps.ids.create(),
              toolName: call.toolName,
              reason: "user_input_superseded",
            });
          }
          continue;
        }

        if (completion.toolCalls.length === 0) {
          const finished = finishRun(context.run, "completed");
          if (!finished.ok) return this.#fail(context, finished.code);
          context.run = finished.value;
          await this.#record(context, "run_completed", {
            kind: "run_completed",
            text: completion.text,
          });
          return this.#result(context, "completed", completion.text, null);
        }

        for (const call of completion.toolCalls) {
          const callResult = await this.#executeCall(context, call);
          if (callResult.kind === "stop") return callResult.result;
        }
      }
    } catch {
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
    return true;
  }

  async #completeWithRetries(
    context: MutableRunContext,
    modelRequestId: string,
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
        onRequestStarted: async (requestId, attemptNo) => {
          await this.#record(context, "model_request_started", {
            kind: "model_request_started",
            modelRequestId: requestId,
            attemptNo,
          });
        },
        onRetryScheduled: async (input) => {
          await this.#record(context, "model_retry_scheduled", {
            kind: "model_retry_scheduled",
            ...input,
          });
        },
      },
      modelRequestId,
      context.conversation,
    );

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
    context.cancelledDuring = "tool_execution";
    const outcome = await executeToolCall(
      {
        tools: this.#deps.tools,
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
        deferApprovals: this.#deps.suspendOnApproval ?? false,
        onEvent: async (type, payload) => {
          await this.#record(context, type, payload as InternalEvent["payload"]);
        },
      },
      call,
    );
    context.cancelledDuring = null;

    if (outcome.kind === "waiting") {
      return this.#awaitApproval(context, outcome);
    }
    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    this.#appendToolResult(context, call, outcome.status, outcome.text);
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
        tools: this.#deps.tools,
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
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

    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "waiting") {
      return { kind: "stop", result: await this.#fail(context, "approval_wait_repeated") };
    }
    this.#appendToolResult(context, pending.call, outcome.status, outcome.text);
    if (context.cancelRequested) {
      return { kind: "stop", result: await this.#cancel(context) };
    }
    return { kind: "continue" };
  }

  #appendToolResult(
    context: MutableRunContext,
    call: ProviderToolCall,
    status: "succeeded" | "failed" | "denied" | "outcome_unknown",
    text: string | null,
  ): void {
    context.conversation.push({
      kind: "tool_result",
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      status,
      text,
    });
  }

  async #record(
    context: MutableRunContext,
    type: InternalEvent["type"],
    payload: InternalEvent["payload"],
  ): Promise<void> {
    const input: EventInput = {
      sessionId: context.sessionId,
      runId: context.runId,
      type,
      correlationId: context.correlationId,
      causationId: context.lastEventId,
      timestampUtc: this.#deps.nowUtc(),
      payload,
    };
    const event = await this.#deps.eventLog.append(input);
    context.events.push(event);
    context.lastEventId = event.eventId;
  }

  async #cancel(context: MutableRunContext): Promise<CoordinatorResult> {
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

  #result(
    context: MutableRunContext,
    status: "completed" | "failed" | "cancelled" | "waiting",
    text: string | null,
    safeCode: string | null,
  ): CoordinatorResult {
    return {
      status,
      run: context.run,
      events: [...context.events],
      text,
      safeCode,
    } as CoordinatorResult;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
