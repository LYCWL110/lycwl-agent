import { addModelRound, createRunBudget } from "../../domain/run/run-budget.ts";
import {
  consumeRunInput,
  emptyRunInputQueue,
  queueRunInput,
  type RunInputQueue,
} from "../../domain/run/input-queue.ts";
import {
  finishRun,
  startRun,
  waitRun,
  type Run,
} from "../../domain/run/run-state.ts";
import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type {
  ModelProvider,
  ProviderConversationItem,
} from "../../ports/model-provider.ts";
import type { ToolExecutor } from "../../ports/tool-executor.ts";
import type { EventInput, EventLog } from "./event-log.ts";
import type { InternalEvent } from "./internal-events.ts";
import { completeWithBoundedRetries } from "./model-attempts.ts";
import { executeToolCall } from "./tool-call-execution.ts";

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
    };
    await this.#record(context, "run_started", { kind: "run_started", input });
    this.#activeContext = context;

    try {
      while (context.run.state === "active") {
        const round = addModelRound(context.budget);
        if (!round.ok) return this.#fail(context, round.code);
        context.budget = round.value;

        const modelRequestId = this.#deps.ids.create();
        const completion = await this.#completeWithRetries(context, modelRequestId);
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
    } finally {
      this.#activeContext = null;
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
  ):
    Promise<
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
        const waiting = waitRun(context.run, "configuration", this.#deps.ids.create(), 1);
        if (!waiting.ok) {
          return { kind: "failed", result: await this.#fail(context, waiting.code) };
        }
        context.run = waiting.value;
        await this.#record(context, "run_waiting", {
          kind: "run_waiting",
          reason: "configuration",
          safeCode: outcome.safeCode,
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
  ): Promise<Readonly<{ kind: "continue" }> | Readonly<{ kind: "stop"; result: CoordinatorResult }>> {
    if (context.run.state !== "active") {
      return { kind: "stop", result: await this.#fail(context, "run_not_active") };
    }
    const outcome = await executeToolCall(
      {
        tools: this.#deps.tools,
        approvals: this.#deps.approvals,
        ids: this.#deps.ids,
        onEvent: async (type, payload) => {
          await this.#record(context, type, payload as InternalEvent["payload"]);
        },
      },
      call,
    );
    if (outcome.kind === "invalid") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    if (outcome.kind === "unknown") {
      return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
    }
    this.#appendToolResult(context, call, outcome.status, outcome.text);
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
