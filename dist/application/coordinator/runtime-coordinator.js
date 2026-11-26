import { computeContextBudget, conservativeEstimate, decideRequestFit, } from "../../domain/context/context-budget.js";
import { mergeTouchedPaths, touchedPaths, } from "../../domain/context/touched-paths.js";
import { exceedsSpillThreshold, spillToolOutput } from "../../domain/evidence/tool-spill.js";
import { renderMemoryBlock, selectMemoryForTask } from "../../domain/memory/memory.js";
import { bindAttempt } from "../../domain/model-request/run-binding.js";
import { addUsage } from "../../domain/model-request/token-usage.js";
import { describeSyntaxFailure } from "../../domain/mutation/syntax-check.js";
import { emptyTodoList, replaceTodoList } from "../../domain/planning/todo.js";
import { questionOutcome, validateUserAnswer, } from "../../domain/question/ask-user.js";
import { consumeRunInput, emptyRunInputQueue, queueRunInput, } from "../../domain/run/input-queue.js";
import { checkIdenticalCall, } from "../../domain/run/no-progress.js";
import { addCompaction, addModelRound, createRunBudget, RUN_BUDGET_LIMITS, } from "../../domain/run/run-budget.js";
import { finishRun, resumeRun, startRun, waitRun } from "../../domain/run/run-state.js";
import { describeIssues, validateValue } from "../../domain/tool-invocation/argument-validation.js";
import { resolveUncertainty } from "../../domain/tool-invocation/execution-semantics.js";
import { spilledResult, unconfirmed, } from "../../domain/tool-invocation/result-completeness.js";
import { assertProtectedValue, guardToolResultText, ProtectedDeliveryError, } from "../../services/security/guarded-delivery.js";
import { deriveTaskReport } from "../task-report/derive-task-report.js";
import { estimateArtifactTokens, parseCompactionArtifact, prepareCompaction, validateArtifact, } from "./compaction-service.js";
import { compactConversation } from "./conversation-rebuild.js";
import { completeWithBoundedRetries } from "./model-attempts.js";
import { executeToolCall } from "./tool-call-execution.js";
export class RuntimeCoordinator {
    #deps;
    #sessionId;
    #conversation;
    #activeContext = null;
    #pendingRun = null;
    #closing = null;
    #sensitiveSources;
    #lastResult = null;
    #backgroundContexts = new Map();
    #backgroundTerminal = new Set();
    #stopBackgroundObservation;
    #persistenceFailed = false;
    constructor(dependencies) {
        this.#deps = dependencies;
        this.#sessionId = dependencies.sessionId ?? dependencies.ids.create();
        this.#conversation = [...(dependencies.priorConversation ?? [])];
        this.#sensitiveSources = [...(dependencies.sensitiveSources ?? [])];
        this.#stopBackgroundObservation = dependencies.tools.observeBackground?.(async (task) => {
            const context = this.#backgroundContexts.get(task.launchingToolCallId);
            if (context === undefined ||
                context.sessionId !== task.sessionId ||
                context.runId !== task.ownerRunId ||
                !context.events.some(({ payload }) => payload.kind === "tool_dispatch_committed" &&
                    payload.toolCallId === task.launchingToolCallId))
                throw new Error("background_owner_invalid");
            const identity = `${task.taskId}:${task.processExecutionId}`;
            if (this.#backgroundTerminal.has(identity))
                return;
            await this.#record(context, "background_task_observed", {
                kind: "background_task_observed",
                task,
            });
            if ("deliveryBlocked" in task && task.deliveryBlocked !== undefined) {
                context.deliveryBlocked = true;
                context.deliveryBlockReason = task.deliveryBlocked;
                if (this.#activeContext !== null) {
                    this.#activeContext.deliveryBlocked = true;
                    this.#activeContext.deliveryBlockReason = task.deliveryBlocked;
                    // Deliberately not aborting the in-flight request here. Aborting made the
                    // Run report `tool_cancelled` and skip the delivery-block wait entirely,
                    // because the cancellation path wins before the block is observed. The
                    // flag is checked at the next safe boundary, which is where a blocked
                    // result must take effect: the current response finishes, then the Run
                    // enters recovery review with the real reason preserved.
                }
            }
            if (!["registered", "running"].includes(task.state))
                this.#backgroundTerminal.add(identity);
        });
    }
    /**
     * Durably accept ordinary supplementary input for the current Run. Arrival is
     * not authorization: it only updates task context at the next safe boundary.
     */
    async queueInput(text) {
        const context = this.#activeContext;
        if (context === null)
            return { ok: false, code: "run_terminal" };
        return this.#serialize(context, async () => {
            const acceptedSeq = context.nextAcceptedSeq;
            const queued = queueRunInput(context.inputQueue, {
                commandId: this.#deps.ids.create(),
                inputId: this.#deps.ids.create(),
                text,
                acceptedSeq,
                runState: context.run.state,
            });
            if (!queued.ok)
                return { ok: false, code: queued.code };
            if (queued.duplicate)
                return { ok: true, inputId: null };
            const item = queued.queue.items.at(-1);
            if (item === undefined)
                return { ok: true, inputId: null };
            await this.#recordNow(context, "run_input_queued", {
                kind: "run_input_queued",
                inputId: item.inputId,
                text: item.text,
                acceptedSeq: item.acceptedSeq,
            });
            context.inputQueue = queued.queue;
            context.nextAcceptedSeq = acceptedSeq + 1;
            return { ok: true, inputId: item.inputId };
        });
    }
    /**
     * Durably record a CancelRun command for the current Run. Cancellation never
     * undoes a side effect that already started; the loop stops before any further
     * dispatch and reports what was actually executing.
     */
    async cancelRun(commandId) {
        const context = this.#activeContext;
        if (commandId.length === 0)
            return { ok: false, code: "invalid_identity" };
        if (context === null)
            return { ok: false, code: "run_terminal" };
        if (context.cancelCommandIds.has(commandId)) {
            return { ok: true, duplicate: true };
        }
        if (context.run.state === "completed" ||
            context.run.state === "failed" ||
            context.run.state === "cancelled") {
            return { ok: false, code: "run_terminal" };
        }
        context.cancelCommandIds.add(commandId);
        try {
            await this.#record(context, "run_cancel_requested", {
                kind: "run_cancel_requested",
                commandId,
            });
        }
        finally {
            // Persistence/guard failure must not leave an already-running process
            // alive or allow another dispatch. Durable recovery remains uncertain.
            context.cancelRequested = true;
            context.abortController.abort();
            context.pendingApproval?.resolve();
            context.pendingQuestion?.resolve();
            context.pendingDisclosure?.resolve();
            await this.#deps.tools.cancelAll?.();
        }
        if (this.#pendingRun === null &&
            context.pendingResume === null &&
            context.run.state === "waiting" &&
            (context.run.reason === "configuration" || context.run.reason === "recovery_review")) {
            await this.#cancel(context);
            this.#activeContext = null;
        }
        return { ok: true, duplicate: false };
    }
    /** Session resources outlive completed Runs, but never a closed Session. */
    closeSession(commandId) {
        if (this.#closing === null)
            this.#closing = this.#closeSession(commandId);
        return this.#closing;
    }
    async #closeSession(commandId) {
        const context = this.#activeContext;
        let failure;
        try {
            const cancelled = await this.cancelRun(commandId);
            if (!cancelled.ok)
                await this.#deps.tools.cancelAll?.();
        }
        catch (error) {
            failure = error;
        }
        try {
            await this.#pendingRun;
            await context?.pendingResume;
        }
        catch (error) {
            failure ??= error;
        }
        try {
            // The loop can enter a configuration/recovery wait while close awaits it.
            // Settle that final state before releasing Session ownership.
            if (context?.run.state === "waiting" &&
                (context.run.reason === "configuration" || context.run.reason === "recovery_review")) {
                await this.#cancel(context);
                this.#activeContext = null;
            }
        }
        catch (error) {
            failure ??= error;
        }
        // A failed process cleanup retains ownership. A failed fact write does not
        // prevent closing resources after all execution has actually stopped.
        if (failure !== undefined)
            await this.#deps.tools.cancelAll?.();
        await this.#deps.releaseSession?.();
        this.#stopBackgroundObservation?.();
        if (failure !== undefined)
            throw failure;
    }
    /**
     * Snapshot of current facts for a TUI; reading it performs no transition.
     */
    currentRunProjection() {
        const context = this.#activeContext;
        return context === null
            ? null
            : {
                status: context.run.state,
                events: context.events.slice(),
                streaming: context.streamingText.length === 0 ? null : { text: context.streamingText },
            };
    }
    configurationWaitView() {
        const run = this.#activeContext?.run;
        return run?.state === "waiting" && run.reason === "configuration"
            ? { waitToken: run.waitToken, requestVersion: run.requestVersion }
            : null;
    }
    lastRunResult() {
        return this.#lastResult;
    }
    /** Reading a pending approval grants no authority. */
    pendingApprovalView() {
        const pending = this.#activeContext?.pendingApproval;
        if (pending === null || pending === undefined)
            return null;
        return {
            approvalId: pending.approvalId,
            toolCallId: pending.toolCallId,
            toolName: pending.call.toolName,
            requestVersion: pending.requestVersion,
        };
    }
    pendingDisclosureView() {
        const pending = this.#activeContext?.pendingDisclosure;
        if (pending == null)
            return null;
        return {
            disclosureId: pending.disclosureId,
            requestVersion: pending.requestVersion,
            requestFingerprint: pending.requestFingerprint,
            safePreview: pending.safePreview,
        };
    }
    async replySensitiveDisclosure(input) {
        const pending = this.#activeContext?.pendingDisclosure;
        if (pending == null ||
            input.commandId.length === 0 ||
            pending.disclosureId !== input.disclosureId ||
            pending.requestVersion !== input.requestVersion ||
            pending.requestFingerprint !== input.requestFingerprint)
            return { ok: false };
        if (pending.decision !== null)
            return { ok: pending.commandId === input.commandId && pending.decision === input.decision };
        // Only the coordinator continuation persists and acts on this command.
        pending.decision = input.decision;
        pending.commandId = input.commandId;
        pending.resolve();
        return { ok: true };
    }
    /**
     * Record an approval reply for the pending approval wait. A matching reply
     * resolves that wait directly; a duplicate commandId cannot decide twice.
     */
    async replyApproval(input) {
        const context = this.#activeContext;
        if (input.commandId.length === 0 || input.approvalId.length === 0) {
            return { ok: false, code: "invalid_identity" };
        }
        if (context === null)
            return { ok: false, code: "run_terminal" };
        const pending = context.pendingApproval;
        if (pending === null)
            return { ok: false, code: "not_waiting_for_approval" };
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
    pendingQuestionView() {
        const pending = this.#activeContext?.pendingQuestion;
        if (pending === null || pending === undefined)
            return null;
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
    async submitUserInput(input) {
        return this.#resolveQuestion(input, (question) => {
            const validated = validateUserAnswer(question, input.answer);
            if (!validated.ok)
                return { ok: false, code: validated.code };
            return { ok: true, outcome: questionOutcome("answered", validated.text) };
        });
    }
    /** Explicitly decline the pending question: a failed tool result, not approval. */
    async declineQuestion(input) {
        return this.#resolveQuestion(input, () => ({
            ok: true,
            outcome: questionOutcome("declined", null),
        }));
    }
    /** Cancel only this question; this is not CancelRun. */
    async cancelQuestion(input) {
        return this.#resolveQuestion(input, () => ({
            ok: true,
            outcome: questionOutcome("cancelled", null),
        }));
    }
    /** Report that no usable interaction channel exists for the question. */
    async markQuestionUnavailable(input) {
        return this.#resolveQuestion(input, () => ({
            ok: true,
            outcome: questionOutcome("unavailable", null),
        }));
    }
    /** Closing the panel retains the wait; it is a view event only. */
    async closeQuestionView(questionId) {
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
    async #resolveQuestion(input, decide) {
        const context = this.#activeContext;
        if (input.commandId.length === 0 || input.questionId.length === 0) {
            return { ok: false, code: "invalid_identity" };
        }
        if (context === null)
            return { ok: false, code: "run_terminal" };
        const pending = context.pendingQuestion;
        if (pending === null)
            return { ok: false, code: "not_waiting_for_question" };
        if (pending.commandIds.has(input.commandId))
            return { ok: true, duplicate: true };
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
        if (!decided.ok)
            return { ok: false, code: decided.code };
        pending.commandIds.add(input.commandId);
        pending.outcome = decided.outcome;
        pending.resolve();
        return { ok: true, duplicate: false };
    }
    /**
     * Start a Run.
     *
     * `skillId` asks the coordinator to load that workspace Skill and inject its body
     * as a user message before the task. The body is untrusted project material with
     * a provenance header; it grants no approval and changes no policy.
     */
    run(input, options = {}) {
        if (this.#closing !== null)
            return Promise.reject(new Error("session_closed"));
        if (this.#persistenceFailed)
            return Promise.reject(new Error("session_persistence_failed"));
        if (this.#pendingRun !== null || this.#activeContext !== null)
            return Promise.reject(new Error("session_busy"));
        const pending = this.#startRun(input, options);
        this.#pendingRun = pending;
        const clear = () => {
            if (this.#pendingRun === pending)
                this.#pendingRun = null;
        };
        pending.then(clear, clear);
        return pending;
    }
    async #startRun(input, options) {
        const projectContext = this.#deps.projectContext;
        // Memory is read at Run start, not at process start, so a `/remember` issued
        // before the next task is visible without restarting the Session.
        let memoryBlock = null;
        if (this.#deps.memory !== undefined && this.#deps.memoryProjectRoot !== undefined) {
            const loaded = await this.#deps.memory.load();
            if (loaded.ok) {
                memoryBlock = renderMemoryBlock(selectMemoryForTask(loaded.entries, {
                    projectRoot: this.#deps.memoryProjectRoot,
                    task: input,
                    nowUtc: this.#deps.nowUtc(),
                }));
            }
            // A store failure omits memory rather than substituting a guessed entry.
        }
        // A requested skill is loaded before the Run starts, so a failure is a clean
        // refusal rather than a Run that fails partway. The body becomes a user
        // message with a provenance header; it grants nothing.
        let skillBlock = null;
        if (options.skillId !== undefined) {
            const loader = this.#deps.loadSkill;
            if (loader === undefined) {
                return this.#refuseBeforeStart("skill_tool_unavailable");
            }
            const loaded = await loader({ skillId: options.skillId });
            if (!loaded.ok) {
                return this.#refuseBeforeStart(`skill_${loaded.code}`);
            }
            skillBlock = loaded.block;
        }
        const context = {
            run: startRun(),
            sessionId: this.#sessionId,
            runId: this.#deps.ids.create(),
            correlationId: this.#deps.ids.create(),
            events: [],
            budget: createRunBudget(),
            usage: undefined,
            streamingText: "",
            spilledPreviews: new Map(),
            editSnapshots: new Map(),
            lastBudgetTick: this.#nowMs(),
            accountingActive: true,
            costUnknown: false,
            budgetTimer: null,
            elapsedExceeded: false,
            lastEventId: null,
            conversation: [
                ...(projectContext === undefined ? [] : [{ kind: "user", text: projectContext }]),
                ...this.#conversation,
                ...(skillBlock === null ? [] : [{ kind: "user", text: skillBlock }]),
                ...(memoryBlock === null ? [] : [{ kind: "user", text: memoryBlock }]),
                // Images ride on the task turn, not on a separate one: the model must read
                // them as part of the request, and a separate turn would be a second task.
                options.images === undefined || options.images.length === 0
                    ? { kind: "user", text: input }
                    : { kind: "user", text: input, images: options.images },
            ],
            inputQueue: emptyRunInputQueue(),
            nextAcceptedSeq: 1,
            taskRevision: 1,
            taskInputs: [input],
            pendingModel: null,
            cancelRequested: false,
            abortController: new AbortController(),
            stopSiblings: false,
            cancelCommandIds: new Set(),
            cancelledDuring: null,
            pendingApproval: null,
            pendingQuestion: null,
            pendingDisclosure: null,
            approvalCredentialRevisions: new Map(),
            resumeCommandIds: new Set(),
            pendingResume: null,
            checkpointFailure: null,
            deliveryBlocked: false,
            deliveryBlockReason: null,
            todoList: emptyTodoList(),
            runBinding: this.#deps.runBinding ?? null,
            callHistory: [],
            newInputSinceLastCall: false,
            touchedPaths: [],
            guidanceSources: new Map((this.#deps.initialGuidanceSources ?? []).map((source) => [source.path, source.sha256])),
            guidanceText: projectContext ?? null,
            eventTail: Promise.resolve(),
            replanRequested: false,
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
        }
        catch (error) {
            if (error instanceof ProtectedDeliveryError)
                return this.#blockDelivery(context, error.reason);
            this.#activeContext = null;
            throw error;
        }
        const result = this.#deps.preflightFailure === undefined
            ? await this.#loop(context)
            : await this.#fail(context, this.#deps.preflightFailure);
        if (context.run.state !== "waiting")
            this.#activeContext = null;
        return result;
    }
    /**
     * Resume a Run that is waiting for configuration or recovery review. A
     * matching approval/question reply resolves its own wait and does not need
     * this command.
     */
    async resumeRun(input) {
        if (this.#closing !== null)
            return { ok: false, code: "run_terminal" };
        if (input.commandId.length === 0 || input.waitToken.length === 0) {
            return { ok: false, code: "invalid_identity" };
        }
        const context = this.#activeContext;
        if (context === null)
            return { ok: false, code: "run_terminal" };
        if (context.resumeCommandIds.has(input.commandId)) {
            return { ok: true, duplicate: true };
        }
        if (context.run.state !== "waiting" || context.run.reason !== "configuration") {
            return { ok: false, code: "not_waiting_for_configuration" };
        }
        if (context.run.waitToken !== input.waitToken ||
            context.run.requestVersion !== input.requestVersion) {
            return { ok: false, code: "not_waiting_for_configuration" };
        }
        context.resumeCommandIds.add(input.commandId);
        const resumed = resumeRun(context.run);
        if (!resumed.ok)
            return { ok: false, code: "run_terminal" };
        context.run = resumed.value;
        await this.#record(context, "run_resumed", { kind: "run_resumed" });
        context.pendingResume = this.#loop(context);
        const pending = context.pendingResume;
        pending.then(() => {
            if (context.run.state !== "waiting")
                this.#activeContext = null;
            if (context.pendingResume === pending)
                context.pendingResume = null;
        }, () => {
            if (context.pendingResume === pending)
                context.pendingResume = null;
        });
        return { ok: true, duplicate: false };
    }
    /** Await the continuation queued by a previous resumeRun, if any. */
    async settle() {
        const pending = this.#activeContext?.pendingResume;
        if (pending === undefined)
            return null;
        return pending;
    }
    async #loop(context) {
        try {
            while (context.run.state === "active") {
                if (this.#persistenceFailed)
                    throw new Error("session_persistence_failed");
                if (context.cancelRequested)
                    return this.#cancel(context);
                if (this.#accountTime(context))
                    return this.#fail(context, "elapsed_limit");
                if (context.deliveryBlocked)
                    return this.#blockDelivery(context, context.deliveryBlockReason ?? "owned_key_detected");
                await this.#consumeQueuedInput(context);
                context.replanRequested = false;
                if (context.pendingModel === null) {
                    const round = addModelRound(context.budget);
                    if (!round.ok)
                        return this.#fail(context, round.code);
                    context.budget = round.value;
                }
                // Refresh scoped guidance at the request boundary, before any send. A file
                // touched since the last round may bring a directory's AGENTS.md into scope.
                await this.#refreshGuidance(context);
                if (context.cancelRequested)
                    return this.#cancel(context);
                // Budget and compaction happen at the same boundary: both must precede the
                // request, and a compaction that fails must leave the old context usable.
                if (context.pendingModel?.auxiliary !== false) {
                    const compaction = await this.#maybeCompact(context);
                    if (compaction.kind === "stop")
                        return compaction.result;
                }
                const modelRequestId = context.pendingModel?.modelRequestId ?? this.#deps.ids.create();
                context.cancelledDuring = "model_request";
                const completion = await this.#completeWithRetries(context, modelRequestId);
                context.streamingText = "";
                context.cancelledDuring = null;
                if (completion.kind === "terminal")
                    return completion.result;
                if (context.cancelRequested)
                    return this.#cancel(context);
                if (completion.kind === "waiting")
                    return completion.result;
                if (completion.kind === "failed")
                    return completion.result;
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
                    ...(completion.usage === undefined ? {} : { usage: completion.usage }),
                });
                // Usage is recorded per request and accumulated per Run. A provider that
                // reports nothing leaves the total unknown; that is reported as unknown
                // rather than silently counted as zero.
                if (completion.usage !== undefined) {
                    context.usage = addUsage(context.usage, completion.usage);
                    // The provider priced this request, so it is no longer an unknown charge.
                    context.costUnknown = false;
                }
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
                const superseded = await this.#consumeQueuedInput(context);
                if (context.cancelRequested)
                    return this.#cancel(context);
                if (superseded)
                    continue;
                if (completion.toolCalls.length === 0) {
                    await this.#deps.tools.flushBackground?.();
                    if (context.deliveryBlocked)
                        return this.#blockDelivery(context, context.deliveryBlockReason ?? "owned_key_detected");
                    const completed = await this.#serialize(context, async () => {
                        if (context.inputQueue.items.length > 0)
                            return false;
                        const finished = finishRun(context.run, "completed");
                        if (!finished.ok)
                            throw new Error(finished.code);
                        context.run = finished.value;
                        await this.#recordNow(context, "run_completed", {
                            kind: "run_completed",
                            text: guardedCompletionText,
                        });
                        return true;
                    });
                    if (!completed)
                        continue;
                    return this.#result(context, "completed", guardedCompletionText, null);
                }
                for (const [index, call] of completion.toolCalls.entries()) {
                    if (await this.#consumeQueuedInput(context))
                        break;
                    const callResult = await this.#executeCall(context, call);
                    if (callResult.kind === "stop")
                        return callResult.result;
                    if (context.replanRequested)
                        break;
                    if (await this.#consumeQueuedInput(context))
                        break;
                    if (context.deliveryBlocked)
                        return this.#blockDelivery(context, context.deliveryBlockReason ?? "owned_key_detected");
                    if (context.stopSiblings) {
                        context.stopSiblings = false;
                        for (const remaining of completion.toolCalls.slice(index + 1)) {
                            await this.#appendToolResult(context, remaining, "failed", "not_attempted: sibling mutation failed or was denied");
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
        }
        catch (error) {
            context.streamingText = "";
            if (this.#persistenceFailed) {
                this.#clearBudgetTimer(context);
                await this.#deps.tools.cancelAll?.();
                throw new Error("session_persistence_failed");
            }
            if (error instanceof ProtectedDeliveryError)
                return this.#blockDelivery(context, error.reason);
            if (context.elapsedExceeded)
                return this.#fail(context, "elapsed_limit");
            return this.#fail(context, "unexpected_internal_error");
        }
        return this.#result(context, context.run.state === "completed"
            ? "completed"
            : context.run.state === "cancelled"
                ? "cancelled"
                : context.run.state === "waiting"
                    ? "waiting"
                    : "failed", null, "unexpected_run_state");
    }
    /**
     * Consume queued input at the safe boundary before any dispatch. Returns true
     * when new input superseded the current response's undispatched calls.
     */
    async #consumeQueuedInput(context) {
        return this.#serialize(context, async () => {
            const pending = context.inputQueue.items;
            if (pending.length === 0)
                return false;
            const throughSeq = pending.at(-1)?.acceptedSeq ?? 0;
            const consumed = consumeRunInput(context.inputQueue, throughSeq, context.taskRevision);
            if (!consumed.ok)
                return false;
            await this.#recordNow(context, "run_input_batch_consumed", {
                kind: "run_input_batch_consumed",
                inputIds: consumed.batch.inputIds,
                throughSeq: consumed.batch.throughSeq,
                taskRevision: consumed.batch.taskRevision,
            });
            context.inputQueue = consumed.queue;
            context.taskRevision = consumed.batch.taskRevision + 1;
            const outstanding = new Map();
            for (const item of context.conversation) {
                if (item.kind === "assistant")
                    for (const call of item.toolCalls)
                        outstanding.set(call.providerToolCallId, call);
                else if (item.kind === "tool_result")
                    outstanding.delete(item.providerToolCallId);
            }
            const currentResponse = context.events.findLastIndex(({ payload }) => payload.kind === "model_response_validated");
            for (const call of outstanding.values()) {
                const received = context.events
                    .slice(currentResponse)
                    .findLast(({ payload }) => payload.kind === "tool_call_received" &&
                    payload.providerToolCallId === call.providerToolCallId)?.payload;
                const toolCallId = received?.kind === "tool_call_received" ? received.toolCallId : this.#deps.ids.create();
                this.#deps.tools.discardApproval?.(toolCallId);
                const decision = context.events.findLast(({ payload }) => payload.kind === "approval_decided" && payload.toolCallId === toolCallId)?.payload;
                if (decision?.kind === "approval_decided" && decision.decision === "approved") {
                    await this.#recordNow(context, "approval_grant_revoked", {
                        kind: "approval_grant_revoked",
                        approvalId: decision.approvalId,
                        toolCallId,
                        reason: "superseded_input",
                    });
                }
                await this.#recordNow(context, "tool_call_cancelled", {
                    kind: "tool_call_cancelled",
                    toolCallId,
                    providerToolCallId: call.providerToolCallId,
                    toolName: call.toolName,
                    reason: "user_input_superseded",
                });
                await this.#appendToolResult(context, call, "cancelled", null);
            }
            for (const item of pending) {
                context.conversation.push({ kind: "user", text: item.text });
                context.taskInputs.push(item.text);
            }
            // New user input is progress: it resets the identical-call counter for the
            // next call without touching accumulated failure history.
            context.newInputSinceLastCall = true;
            context.replanRequested = true;
            return true;
        });
    }
    async #completeWithRetries(context, modelRequestId, 
    /** Overrides the conversation; used by the auxiliary compaction request. */
    overrideConversation, auxiliaryAttempts) {
        const consented = new Set();
        const previous = context.pendingModel?.modelRequestId === modelRequestId ? context.pendingModel : null;
        let attemptsUsed = previous?.attemptsUsed ?? 0;
        const outcome = await completeWithBoundedRetries({
            provider: this.#deps.provider,
            sleep: this.#deps.sleep ?? sleep,
            signal: context.abortController.signal,
            attemptStart: attemptsUsed + 1,
            onAttemptStarted: () => {
                context.streamingText = "";
            },
            ...(auxiliaryAttempts === undefined
                ? {
                    onDelta: (delta) => {
                        if (delta.kind === "text")
                            context.streamingText += delta.text;
                    },
                }
                : {}),
            ...(auxiliaryAttempts === undefined
                ? {}
                : {
                    attemptStart: auxiliaryAttempts.used + 1,
                    attemptLimit: 2,
                    compaction: {
                        maxOutputTokens: auxiliaryAttempts.maxOutputTokens,
                    },
                }),
            ...(this.#deps.resolveCredentialRevision === undefined
                ? {}
                : { resolveCredentialRevision: this.#deps.resolveCredentialRevision }),
            onRequestStarted: async (requestId, attemptNo, credentialRevision) => {
                if (this.#persistenceFailed)
                    throw new Error("session_persistence_failed");
                if (context.deliveryBlocked)
                    throw new ProtectedDeliveryError(context.deliveryBlockReason ?? "owned_key_detected");
                if (this.#accountTime(context))
                    return { ok: false, safeCode: "elapsed_limit" };
                this.#clearBudgetTimer(context);
                if (auxiliaryAttempts !== undefined)
                    auxiliaryAttempts.used = attemptNo;
                await this.#deps.refreshOwnedKeys?.();
                if (this.#deps.ownedKeys !== undefined) {
                    assertProtectedValue(this.#deps.ownedKeys, overrideConversation ?? context.conversation);
                }
                // C03: an attempt may only advance the revision of the same credential
                // reference. A resolver that reports a different reference would mean a
                // silent identity change inside a Run, which must not be sent.
                const binding = context.runBinding;
                const disclosed = await this.#checkDisclosure(context, requestId, credentialRevision, overrideConversation ?? context.conversation, overrideConversation !== undefined, consented);
                if (!disclosed.ok)
                    return disclosed;
                credentialRevision = disclosed.credentialRevision;
                if (this.#accountTime(context))
                    return { ok: false, safeCode: "elapsed_limit" };
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
                        return { ok: false, safeCode: bound.code };
                    }
                }
                // A request is only a candidate for an unknown charge until its response
                // arrives. Marking it unknown unconditionally made every Run report every
                // attempt as unpriced even when the provider reported usage.
                context.costUnknown = true;
                await this.#record(context, "model_request_started", {
                    kind: "model_request_started",
                    modelRequestId: requestId,
                    attemptNo,
                    ...(overrideConversation === undefined
                        ? {
                            includedInputIds: context.events.flatMap(({ payload }) => payload.kind === "run_input_batch_consumed" ? payload.inputIds : []),
                        }
                        : {}),
                    ...(credentialRevision === null ? {} : { credentialRevision }),
                });
                attemptsUsed = attemptNo;
                this.#armBudgetTimer(context);
                return { ok: true };
            },
            onRetryScheduled: async (input) => {
                await this.#record(context, "model_retry_scheduled", {
                    kind: "model_retry_scheduled",
                    ...input,
                });
            },
        }, modelRequestId, overrideConversation ?? context.conversation);
        this.#clearBudgetTimer(context);
        if (context.deliveryBlocked)
            return {
                kind: "terminal",
                result: await this.#blockDelivery(context, context.deliveryBlockReason ?? "owned_key_detected"),
            };
        if (this.#accountTime(context))
            return {
                kind: "failed",
                result: await this.#fail(context, "elapsed_limit"),
            };
        if (outcome.kind === "cancelled" || context.cancelRequested) {
            return { kind: "terminal", result: await this.#cancel(context) };
        }
        if (outcome.kind === "completed") {
            if (context.pendingModel?.modelRequestId === modelRequestId)
                context.pendingModel = null;
            return outcome;
        }
        if (outcome.kind === "authentication_failure") {
            context.pendingModel = {
                modelRequestId,
                attemptsUsed,
                auxiliary: auxiliaryAttempts !== undefined,
            };
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
            result: await this.#fail(context, outcome.kind === "transient_retries_exhausted"
                ? "transient_retries_exhausted"
                : outcome.safeCode),
        };
    }
    /**
     * Session-scoped tool view. Todo state lives in the Run context and is
     * recorded as an event on every accepted replacement, so a restart restores
     * planning state from facts instead of trusting the model's message history.
     */
    #sessionTools(context) {
        const base = this.#deps.tools;
        const preview = base.preview;
        const previewRevisions = context.approvalCredentialRevisions;
        return {
            getDefinition: (toolName) => base.getDefinition(toolName),
            requiresApproval: async (request) => (await base.requiresApproval?.(request)) ?? false,
            revalidateApproval: async (request) => {
                if (context.runBinding !== null) {
                    const current = (await this.#deps.resolveCredentialRevision?.()) ?? null;
                    if (previewRevisions.get(request.toolCallId) !== current)
                        return false;
                }
                return (await base.revalidateApproval?.(request)) ?? true;
            },
            discardApproval: (id) => base.discardApproval?.(id),
            ...(preview === undefined
                ? {}
                : {
                    preview: async (request) => {
                        const body = await preview.call(base, request);
                        const binding = context.runBinding;
                        if (binding === null || body === null)
                            return body;
                        const revision = (await this.#deps.resolveCredentialRevision?.()) ?? null;
                        previewRevisions.set(request.toolCallId, revision);
                        return [
                            body,
                            `disclosure destination=${binding.endpoint.host}${binding.endpoint.path}`,
                            `model=${binding.modelId}; protocol=${binding.protocolId}`,
                            `credentialRef=${binding.credential.credentialRef}; revision=${revision ?? "unknown"}`,
                        ].join("\n");
                    },
                }),
            execute: async (request) => {
                if (request.toolName === "background_start")
                    this.#backgroundContexts.set(request.toolCallId, context);
                const result = await base.execute({
                    ...request,
                    owner: { sessionId: context.sessionId, runId: context.runId },
                });
                if (result.sensitiveSources !== undefined && result.status === "succeeded") {
                    const binding = context.runBinding;
                    const revision = previewRevisions.get(request.toolCallId) ?? binding?.credential.revision;
                    for (const source of result.sensitiveSources) {
                        const provenance = {
                            ...source,
                            origin: binding == null || revision === undefined
                                ? null
                                : {
                                    providerId: binding.providerId,
                                    modelId: binding.modelId,
                                    protocolId: binding.protocolId,
                                    endpointFingerprint: binding.endpointFingerprint,
                                    credentialRef: binding.credential.credentialRef,
                                    credentialRevision: revision,
                                },
                        };
                        await this.#record(context, "sensitive_source_recorded", {
                            kind: "sensitive_source_recorded",
                            source: provenance,
                        });
                        this.#sensitiveSources.push(provenance);
                    }
                }
                if (request.toolName !== "todo")
                    return result;
                if (result.status !== "succeeded")
                    return result;
                const items = request.arguments?.items;
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
    async #checkDisclosure(context, modelRequestId, credentialRevision, conversation, auxiliary, consented) {
        const binding = context.runBinding;
        const sources = this.#sensitiveSources;
        if (sources.length === 0)
            return { ok: true, credentialRevision };
        // Missing legacy identity is unknown, never evidence for the new destination.
        if (binding === null ||
            credentialRevision === null ||
            this.#deps.requestFingerprint === undefined)
            return { ok: false, safeCode: "sensitive_disclosure_identity_unknown" };
        for (let version = 1;; version++) {
            if (context.cancelRequested)
                return { ok: false, safeCode: "run_cancelled" };
            const affected = sources.filter(({ origin }) => origin === null ||
                origin.providerId !== binding.providerId ||
                origin.modelId !== binding.modelId ||
                origin.protocolId !== binding.protocolId ||
                origin.endpointFingerprint !== binding.endpointFingerprint ||
                origin.credentialRef !== binding.credential.credentialRef ||
                origin.credentialRevision !== credentialRevision);
            if (affected.length === 0)
                return { ok: true, credentialRevision };
            const fingerprint = await this.#deps.requestFingerprint({
                modelRequestId,
                purpose: auxiliary ? "compaction" : "main",
                binding,
                credentialRevision,
                conversation,
                coverage: sources,
            });
            if (consented.has(fingerprint))
                return { ok: true, credentialRevision };
            const disclosureId = this.#deps.ids.create();
            const safePreview = [
                "Sensitive context redisclosure",
                `provider=${binding.providerId}`,
                `model=${binding.modelId}; protocol=${binding.protocolId}`,
                `endpoint=${binding.endpoint.host}${binding.endpoint.port === null ? "" : `:${binding.endpoint.port}`}${binding.endpoint.path}`,
                `credentialRef=${binding.credential.credentialRef}; revision=${credentialRevision}`,
                `purpose=${auxiliary ? "compaction" : "main request"}`,
                `request=${modelRequestId}; fingerprint=${fingerprint}`,
                ...affected.map((source) => `source=${source.sourceId}; path=${source.label}; sha256=${source.contentDigest}`),
            ].join("\n");
            const wait = waitRun(context.run, "approval", disclosureId, version);
            if (!wait.ok)
                return { ok: false, safeCode: wait.code };
            context.run = wait.value;
            await this.#record(context, "sensitive_disclosure_requested", {
                kind: "sensitive_disclosure_requested",
                disclosureId,
                modelRequestId,
                requestVersion: version,
                requestFingerprint: fingerprint,
                safePreview,
                sourceIds: affected.map((source) => source.sourceId),
            });
            await this.#record(context, "run_waiting", {
                kind: "run_waiting",
                reason: "approval",
                safeCode: "sensitive_disclosure_required",
                waitToken: disclosureId,
                requestVersion: version,
            });
            await new Promise((resolve) => {
                context.pendingDisclosure = {
                    disclosureId,
                    modelRequestId,
                    requestVersion: version,
                    requestFingerprint: fingerprint,
                    safePreview,
                    decision: null,
                    commandId: null,
                    resolve,
                };
                if (context.cancelRequested)
                    resolve();
            });
            const pending = context.pendingDisclosure;
            context.pendingDisclosure = null;
            if (pending === null)
                return { ok: false, safeCode: "sensitive_disclosure_lost" };
            await this.#record(context, "sensitive_disclosure_decided", {
                kind: "sensitive_disclosure_decided",
                disclosureId,
                modelRequestId,
                requestVersion: version,
                requestFingerprint: fingerprint,
                decision: context.cancelRequested ? "cancelled" : (pending.decision ?? "cancelled"),
                commandId: pending.commandId,
            });
            if (context.cancelRequested)
                return { ok: false, safeCode: "run_cancelled" };
            const resumed = resumeRun(context.run);
            if (!resumed.ok)
                return { ok: false, safeCode: resumed.code };
            context.run = resumed.value;
            if (pending.decision !== "approved")
                return { ok: false, safeCode: "sensitive_disclosure_denied" };
            // Supplementary input changes the task and therefore invalidates this
            // exact request rather than treating the new message as consent.
            if (context.inputQueue.items.length > 0)
                return { ok: false, safeCode: "sensitive_disclosure_context_changed" };
            consented.add(fingerprint);
            const currentRevision = await this.#deps.resolveCredentialRevision?.();
            if (currentRevision == null)
                return { ok: false, safeCode: "credential_binding_failed" };
            credentialRevision = currentRevision;
            // Rebuild the fingerprint and preview if identity changed while waiting.
        }
    }
    /**
     * Compare this call against recorded identical calls. Fingerprints are built
     * from the tool name/version, the canonicalized input and the resource version,
     * never from free error text or a regenerated id.
     */
    #checkProgress(context, call) {
        const fingerprint = {
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
     * Append guidance discovered after the launch block.
     *
     * The launch block stays byte-identical so the cached prefix survives. New
     * sources arrive as a separate `[project-guidance-update]` user turn; the
     * update lists the new files and states that earlier guidance remains in
     * force. Appending at the end changes no earlier message.
     *
     * A resolver failure keeps the existing text: guidance is helpful context, and
     * losing it mid-Run would be a silent behaviour change.
     */
    async #refreshGuidance(context) {
        const resolver = this.#deps.resolveProjectGuidance;
        if (resolver === undefined)
            return;
        let resolved;
        const known = [...context.guidanceSources].map(([path, sha256]) => ({ path, sha256 }));
        try {
            resolved = await resolver(context.touchedPaths, known);
        }
        catch {
            return;
        }
        if (resolved === null)
            return;
        if (resolved.sources.length > 0 || resolved.removedSources.length > 0) {
            context.guidanceText = resolved.text.length === 0 ? null : resolved.text;
        }
        const changes = [...resolved.addedSources, ...resolved.changedSources];
        const changeCount = changes.length + resolved.removedSources.length;
        // With no guidance in the launch block, the first discovery is the normal
        // guidance block, not an "update" that claims earlier guidance exists.
        const updateText = context.guidanceSources.size === 0 &&
            resolved.changedSources.length === 0 &&
            resolved.removedSources.length === 0
            ? resolved.text
            : resolved.updateText;
        if (changeCount === 0 || updateText.length === 0)
            return;
        for (const source of changes)
            context.guidanceSources.set(source.path, source.sha256);
        for (const path of resolved.removedSources)
            context.guidanceSources.delete(path);
        context.conversation.push({ kind: "user", text: updateText });
    }
    /**
     * Estimate the prompt and compact when it exceeds the trigger.
     *
     * Rules this respects:
     * - above the trigger but within P, an irreducible context is still sent;
     * - above P, nothing is sent;
     * - at most one regeneration per compaction, then fail;
     * - invalid artifacts retain history; exhausting regeneration fails the Run.
     */
    async #maybeCompact(context) {
        const configured = this.#deps.contextBudget;
        if (configured === undefined)
            return { kind: "continue" };
        const computed = computeContextBudget({
            window: configured.window,
            modelMaxOutput: configured.output,
            userMaxOutput: configured.output,
            fixed: configured.fixed +
                conservativeEstimate(estimateConversationTokens(context.taskInputs.map((text) => ({ kind: "user", text })))),
        });
        if (!computed.ok)
            return { kind: "stop", result: await this.#fail(context, "context_capacity_insufficient") };
        const budget = computed.value;
        const estimate = conservativeEstimate(budget.fixed + estimateConversationTokens(context.conversation));
        const fit = decideRequestFit({
            budget,
            promptSize: estimate,
            historyIsReducible: context.conversation.length > 2,
        });
        if (fit.outcome === "send")
            return { kind: "continue" };
        if (fit.outcome === "cannot_send") {
            // Over P: refuse rather than send something oversized.
            return { kind: "stop", result: await this.#fail(context, "context_capacity_insufficient") };
        }
        const resumed = context.pendingModel?.auxiliary === true ? context.pendingModel : null;
        const compactionsBefore = context.budget.compactions - (resumed === null ? 0 : 1);
        const auxiliaryAttempts = {
            used: resumed?.attemptsUsed ?? 0,
            maxOutputTokens: Math.min(budget.output, budget.summaryBudget),
        };
        const auxiliaryRequestId = resumed?.modelRequestId ?? this.#deps.ids.create();
        // Regeneration and transient retries share the same two actual sends.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const prepared = prepareCompaction({
                conversation: context.conversation,
                fixedTokens: budget.fixed,
                auxiliaryBudgetTokens: budget.window - auxiliaryAttempts.maxOutputTokens - budget.gap,
                recentBudget: budget.recentBudget,
                compactionsUsed: compactionsBefore,
                fixedContext: [
                    ...(context.guidanceText === null
                        ? []
                        : ["[project-material; untrusted]", context.guidanceText]),
                    "[current-user-inputs; retain verbatim]",
                    ...context.taskInputs.map((text) => JSON.stringify(text)),
                ].join("\n"),
            });
            if (!prepared.ok) {
                await this.#record(context, "context_compaction_rejected", {
                    kind: "context_compaction_rejected",
                    reason: prepared.reason === "capacity_insufficient"
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
            if (planned.summarizedGroupIds.length === 0)
                return { kind: "continue" };
            if (attempt === 1 && resumed === null) {
                const counted = addCompaction(context.budget);
                if (!counted.ok)
                    return { kind: "stop", result: await this.#fail(context, counted.code) };
                context.budget = counted.value;
            }
            const auxiliary = await this.#completeWithRetries(context, auxiliaryRequestId, [{ kind: "user", text: prepared.value.prompt }], auxiliaryAttempts);
            if (auxiliary.kind !== "completed") {
                return { kind: "stop", result: auxiliary.result };
            }
            if (auxiliary.toolCalls.length > 0) {
                await this.#record(context, "context_compaction_rejected", {
                    kind: "context_compaction_rejected",
                    reason: "invalid_artifact",
                    detail: "auxiliary response proposed tools",
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
            const validated = validateArtifact({
                artifact: parsed.artifact,
                plan: planned,
                outputBudgetTokens: budget.summaryBudget,
                estimatedOutputTokens: estimateArtifactTokens(parsed.artifact),
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
            const artifactText = renderArtifact(validated.artifact);
            const candidate = [
                ...(context.guidanceText === null
                    ? []
                    : [
                        {
                            kind: "user",
                            text: context.guidanceText,
                        },
                    ]),
                ...compactConversation(context.conversation.filter((item, index) => index !== 0 || item.kind !== "user" || item.text !== context.guidanceText), planned.recentSuffixGroupIds.length, artifactText, context.taskInputs),
            ];
            if (conservativeEstimate(budget.fixed + estimateConversationTokens(candidate)) >
                budget.promptBudget)
                return { kind: "stop", result: await this.#fail(context, "context_capacity_insufficient") };
            await this.#record(context, "context_compacted", {
                kind: "context_compacted",
                artifactSha256: hashText(JSON.stringify(validated.artifact)),
                summarizedGroupIds: planned.summarizedGroupIds,
                recentSuffixGroupIds: planned.recentSuffixGroupIds,
                sourceHighWaterSeq: planned.sourceHighWaterSeq,
                estimatedAuxiliaryTokens: planned.estimatedAuxiliaryTokens,
                artifactVersion: validated.artifact.schemaVersion,
                summaryText: artifactText,
                pinnedUserInputs: [...context.taskInputs],
            });
            context.conversation = candidate;
            return { kind: "continue" };
        }
        await this.#record(context, "context_compaction_rejected", {
            kind: "context_compaction_rejected",
            reason: "attempts_exhausted",
            detail: "two auxiliary attempts failed validation",
        });
        return { kind: "stop", result: await this.#fail(context, "context_compaction_invalid") };
    }
    /**
     * Reject a call whose arguments do not match the tool's advertised schema.
     *
     * The catalog already sends every built-in tool's JSON Schema to the model. Until
     * now that schema was advisory: each adapter re-checked arguments by hand, so the
     * advertised contract and the enforced one could disagree.
     *
     * MCP tools are skipped: their schema comes from the server and is forwarded
     * verbatim, so validating it here would mean trusting a third party's schema to
     * describe its own arguments correctly. The server validates its own input.
     *
     * Returns null when the call may proceed.
     */
    async #rejectInvalidArguments(context, call) {
        const definition = this.#deps.tools.getDefinition(call.toolName);
        if (definition === null)
            return null;
        const schema = this.#deps.argumentSchemas?.get(call.toolName);
        if (schema === undefined)
            return null;
        const validated = validateValue(schema, call.arguments);
        if (validated.ok)
            return null;
        const detail = describeIssues(validated.issues);
        await this.#record(context, "tool_arguments_rejected", {
            kind: "tool_arguments_rejected",
            providerToolCallId: call.providerToolCallId,
            toolName: call.toolName,
            issueCount: validated.issues.length,
        });
        await this.#appendToolResult(context, call, "failed", `invalid_arguments: the call does not match the tool schema.\n${detail}\nNothing was executed.`);
        context.stopSiblings = true;
        return { kind: "continue" };
    }
    async #executeCall(context, call) {
        if (context.run.state !== "active") {
            return { kind: "stop", result: await this.#fail(context, "run_not_active") };
        }
        if (context.cancelRequested) {
            return { kind: "stop", result: await this.#cancel(context) };
        }
        // Validate against the advertised schema before anything else. A call whose
        // arguments do not match the contract must not reach the approval prompt, the
        // no-progress tracker or the executor: the model was given the schema, so a
        // mismatch is a model error to report rather than an operation to attempt.
        const rejected = await this.#rejectInvalidArguments(context, call);
        if (rejected !== null)
            return rejected;
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
        // Capture the pre-change content of any file this call will touch, so the Run
        // can be reverted. This happens before dispatch: after the write there is
        // nothing left to capture.
        await this.#captureSnapshots(context, call);
        context.cancelledDuring = "tool_execution";
        const outcome = await executeToolCall({
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
                // A finished tool result is recorded here, before the conversation is
                // updated. Spilling at this point keeps the two consistent: a rebuilt
                // conversation then replays exactly what the model originally saw, and the
                // log does not carry a full copy of text the model never received.
                if (type === "tool_execution_finished") {
                    const fact = payload;
                    const spilled = await this.#spillToolText(context, call, fact.text);
                    const wasSpilled = spilled !== fact.text && spilled !== null;
                    if (wasSpilled)
                        context.spilledPreviews.set(call.providerToolCallId, spilled);
                    // Completeness is recorded on the event, not only in the text: a report
                    // or a replay needs the fact, and a marker in prose can be paraphrased
                    // away by a later summary.
                    const completeness = wasSpilled
                        ? spilledResult("the stored copy")
                        : unconfirmedIfUnknown(fact.status);
                    await this.#record(context, type, {
                        ...fact,
                        text: spilled,
                        ...(completeness === undefined ? {} : { completeness }),
                    });
                    return;
                }
                await this.#record(context, type, payload);
            },
        }, call);
        context.cancelledDuring = null;
        if ("deliveryBlocked" in outcome && outcome.deliveryBlocked) {
            context.deliveryBlocked = true;
            context.deliveryBlockReason = outcome.deliveryBlockReason ?? "owned_key_detected";
        }
        if (outcome.kind === "unknown") {
            await this.#recordUnknownOutcome(context, call, outcome.safeCode);
            if (context.cancelRequested)
                return { kind: "stop", result: await this.#cancel(context) };
            return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
        }
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
        // A successful single-file edit is verified before its result is recorded, so a
        // broken edit is reverted and the model is told the file is unchanged. The check
        // runs before the formatter: formatting a file that does not compile would
        // rewrite it on top of a failed edit.
        const verified = outcome.status === "succeeded"
            ? await this.#verifyEditedFile(context, call, outcome.text)
            : { status: outcome.status, text: outcome.text };
        await this.#appendToolResult(context, call, verified.status, verified.text);
        // A successful file change is followed by the project's own formatter, when it
        // has one. This runs after the result is recorded so a formatting failure is
        // reported as its own fact rather than turning the write into a failure.
        if (verified.status === "succeeded")
            await this.#formatTouchedFiles(context, call);
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
        context.touchedPaths = mergeTouchedPaths(context.touchedPaths, touchedPaths(call.toolName, call.arguments));
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
    async #awaitApproval(context, waiting) {
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
        const decision = await new Promise((resolve) => {
            context.pendingApproval = {
                toolCallId: waiting.toolCallId,
                approvalId: waiting.approvalId,
                waitToken: waiting.waitToken,
                requestVersion: waiting.requestVersion,
                call: waiting.call,
                decision: null,
                commandIds: new Set(),
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
        if (await this.#consumeQueuedInput(context))
            return { kind: "continue" };
        const outcome = await executeToolCall({
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
                await this.#record(context, type, payload);
            },
        }, pending.call, {
            toolCallId: pending.toolCallId,
            approvalId: pending.approvalId,
            waitToken: pending.waitToken,
            requestVersion: pending.requestVersion,
            decision,
        });
        if ("deliveryBlocked" in outcome && outcome.deliveryBlocked) {
            context.deliveryBlocked = true;
            context.deliveryBlockReason = outcome.deliveryBlockReason ?? "owned_key_detected";
        }
        if (outcome.kind === "unknown") {
            await this.#recordUnknownOutcome(context, pending.call, outcome.safeCode);
        }
        if (context.cancelRequested && outcome.kind !== "continue")
            return { kind: "stop", result: await this.#cancel(context) };
        if (outcome.kind === "waiting")
            return this.#awaitApproval(context, outcome);
        if (outcome.kind === "invalid") {
            return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
        }
        if (outcome.kind === "unknown") {
            return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
        }
        if (outcome.kind === "question_waiting") {
            return { kind: "stop", result: await this.#fail(context, "approval_wait_repeated") };
        }
        await this.#appendToolResult(context, pending.call, outcome.status, outcome.text);
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
        context.touchedPaths = mergeTouchedPaths(context.touchedPaths, touchedPaths(pending.call.toolName, pending.call.arguments));
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
    async #awaitQuestion(context, waiting) {
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
        const answered = await new Promise((resolve) => {
            context.pendingQuestion = {
                toolCallId: waiting.toolCallId,
                questionId: waiting.questionId,
                waitToken: waiting.waitToken,
                requestVersion: waiting.requestVersion,
                question: waiting.question,
                call: waiting.call,
                outcome: null,
                commandIds: new Set(),
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
        const outcome = await executeToolCall({
            tools: this.#sessionTools(context),
            approvals: this.#deps.approvals,
            ids: this.#deps.ids,
            onEvent: async (type, payload) => {
                await this.#record(context, type, payload);
            },
        }, pending.call, {
            toolCallId: pending.toolCallId,
            questionId: pending.questionId,
            waitToken: pending.waitToken,
            requestVersion: pending.requestVersion,
            outcome: answered,
        });
        if (outcome.kind === "invalid") {
            return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
        }
        if (outcome.kind === "unknown") {
            return { kind: "stop", result: await this.#fail(context, outcome.safeCode) };
        }
        if (outcome.kind === "waiting" || outcome.kind === "question_waiting") {
            return { kind: "stop", result: await this.#fail(context, "question_wait_repeated") };
        }
        await this.#appendToolResult(context, pending.call, outcome.status, outcome.text);
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
        context.touchedPaths = mergeTouchedPaths(context.touchedPaths, touchedPaths(pending.call.toolName, pending.call.arguments));
        context.newInputSinceLastCall = false;
        if (context.cancelRequested) {
            return { kind: "stop", result: await this.#cancel(context) };
        }
        return { kind: "continue" };
    }
    async #appendToolResult(context, call, status, text) {
        // C10: a blocked tool result keeps its real status but its text never
        // reaches model context. Blocking is not evidence of non-execution.
        const registry = this.#deps.ownedKeys;
        const delivery = registry === undefined
            ? { status, text, deliveryBlocked: false }
            : guardToolResultText(registry, status, text);
        if (delivery.deliveryBlocked) {
            context.deliveryBlocked = true;
            context.deliveryBlockReason = delivery.reason;
        }
        // The event path already spilled this text, so the preview is what the
        // conversation carries; the two must agree for a rebuild to be faithful.
        const preview = context.spilledPreviews.get(call.providerToolCallId);
        if (preview !== undefined)
            context.spilledPreviews.delete(call.providerToolCallId);
        context.conversation.push({
            kind: "tool_result",
            providerToolCallId: call.providerToolCallId,
            toolName: call.toolName,
            status,
            text: preview ?? delivery.text,
        });
    }
    /**
     * Record an uncertain outcome, checking what actually happened first.
     *
     * A timeout does not prove failure: the operation may have run and its result may
     * have been lost. The executor is asked to inspect its own effect, and the answer
     * is recorded as a fact rather than used to rewrite the outcome. Reporting
     * `applied` would claim a state nobody observed; reporting `not_applied` would
     * invite a retry that duplicates the effect.
     */
    async #recordUnknownOutcome(context, call, safeCode) {
        const definition = this.#deps.tools.getDefinition(call.toolName);
        let verdict = null;
        try {
            verdict =
                (await this.#deps.tools.verifyOutcome?.({
                    toolCallId: call.providerToolCallId,
                    toolName: call.toolName,
                    arguments: call.arguments,
                })) ?? null;
        }
        catch {
            // A verifier that throws proves nothing about the operation.
            verdict = "inconclusive";
        }
        const resolution = resolveUncertainty(verdict, definition?.uncertaintyGuidance);
        const suffix = resolution.kind === "applied"
            ? " (verified: the effect is present)"
            : resolution.kind === "not_applied"
                ? " (verified: the effect is absent)"
                : ` (${resolution.guidance})`;
        await this.#record(context, "tool_outcome_verified", {
            kind: "tool_outcome_verified",
            toolCallId: call.providerToolCallId,
            verdict: resolution.kind,
        });
        await this.#appendToolResult(context, call, "outcome_unknown", `${safeCode}${suffix}`);
    }
    /**
     * Verify that a single-file edit still compiles, and revert it when it does not.
     *
     * This is the check SWE-agent's ablation credits with part of its result: without
     * it, a syntax error survives into the next turn and costs a round trip at best.
     *
     * Scope is one file. A batch patch is not checked: ten sequential tsc runs cost
     * about three seconds, and ten parallel ones peak near 350 MB, neither of which is
     * acceptable for a check that should be free.
     *
     * A checker that cannot run is reported as skipped, never as a pass: claiming a
     * file compiles when nothing checked it would be a false verification.
     */
    async #verifyEditedFile(context, call, originalText) {
        const checker = this.#deps.syntaxChecker;
        const store = this.#deps.snapshotStore;
        // Returning the original text matters: the verifier replaces the tool result, so
        // a null here would silently discard what the tool actually reported.
        const keep = { status: "succeeded", text: originalText };
        const edit = context.editSnapshots.get(call.providerToolCallId);
        const finish = () => {
            context.editSnapshots.delete(call.providerToolCallId);
            return keep;
        };
        if (checker === undefined)
            return finish();
        // Only a single-path edit is checked. A batch has no single target to verify,
        // and checking every target is the expensive case this deliberately avoids.
        const targets = snapshotTargets(call.arguments);
        if (targets.length !== 1)
            return finish();
        const relativePath = targets[0];
        if (relativePath === undefined)
            return finish();
        if (edit !== undefined && store !== undefined) {
            const current = await store.currentDigest(edit.path);
            if (current.ok) {
                edit.afterSha256 = current.sha256;
                edit.afterKnown = true;
            }
        }
        const absolutePath = this.#deps.resolveWorkspacePath?.(relativePath);
        if (absolutePath === undefined)
            return finish();
        const checked = await checker.check(absolutePath);
        if (checked.kind === "ok") {
            await this.#record(context, "syntax_check_passed", {
                kind: "syntax_check_passed",
                toolCallId: call.providerToolCallId,
                path: relativePath,
            });
            return finish();
        }
        if (checked.kind === "skipped") {
            await this.#record(context, "syntax_check_skipped", {
                kind: "syntax_check_skipped",
                toolCallId: call.providerToolCallId,
                path: relativePath,
                reason: checked.reason,
            });
            return finish();
        }
        // Restore only this edit's immediate pre-change snapshot. The whole-Run undo
        // keeps the first capture per path and is intentionally not used here: it would
        // discard earlier successful edits in the same Run.
        let rollback = "unavailable";
        if (edit !== undefined && edit.afterKnown && store !== undefined) {
            const restored = await store.restoreEdit({
                runId: context.runId,
                entry: edit.before,
                expectedCurrentSha256: edit.afterSha256,
            });
            if (restored.ok)
                rollback = "reverted";
            else if (restored.code === "conflict")
                rollback = "conflict";
        }
        await this.#record(context, "syntax_check_failed", {
            kind: "syntax_check_failed",
            toolCallId: call.providerToolCallId,
            path: relativePath,
            line: checked.line,
            message: checked.message,
            reverted: rollback === "reverted",
            rollback,
        });
        context.editSnapshots.delete(call.providerToolCallId);
        const suffix = rollback === "reverted"
            ? "\nThe edit was reverted; earlier changes in this Run are untouched."
            : rollback === "conflict"
                ? "\nThe file changed after this edit; it was not reverted. Inspect the newer change before retrying."
                : "\nThe edit could not be reverted; inspect the file before retrying.";
        return {
            status: "failed",
            text: describeSyntaxFailure(relativePath, checked) + suffix,
        };
    }
    /**
     * Run the project's formatter over the files a successful mutation wrote.
     *
     * The formatter is an external program, so this is not silent: it records a
     * `tool_output_formatted` event with the outcome, and a failure leaves the file as
     * the tool wrote it rather than reverting. Reverting would discard a successful
     * edit because a formatter objected, which is a worse outcome than unformatted
     * code.
     */
    async #formatTouchedFiles(context, call) {
        const runner = this.#deps.formatter;
        if (runner === undefined)
            return;
        const definition = this.#deps.tools.getDefinition(call.toolName);
        if (definition?.sideEffectClass !== "filesystem_mutation")
            return;
        for (const relativePath of snapshotTargets(call.arguments)) {
            const formatted = await runner.format({
                relativePath,
                resolvedPath: this.#deps.resolveWorkspacePath?.(relativePath) ?? relativePath,
            });
            if (formatted.ok) {
                await this.#record(context, "tool_output_formatted", {
                    kind: "tool_output_formatted",
                    toolCallId: call.providerToolCallId,
                    path: relativePath,
                    formatter: formatted.formatter,
                });
                continue;
            }
            // "No formatter configured" is not a failure worth reporting on every write;
            // it is the normal state of most projects.
            if (formatted.code === "no_configuration" || formatted.code === "unsupported_extension") {
                continue;
            }
            await this.#record(context, "tool_output_format_failed", {
                kind: "tool_output_format_failed",
                toolCallId: call.providerToolCallId,
                path: relativePath,
                reason: formatted.code,
            });
        }
    }
    /**
     * Snapshot the files a mutating call will touch.
     *
     * Only filesystem mutations are captured: a read, a shell command or an MCP call
     * has no target this Harness can enumerate. A shell command can still modify files,
     * and that is a real limitation rather than an oversight: the Harness cannot know
     * which paths a command writes, so it cannot snapshot them.
     */
    async #captureSnapshots(context, call) {
        const store = this.#deps.snapshotStore;
        if (store === undefined)
            return;
        const definition = this.#deps.tools.getDefinition(call.toolName);
        if (definition?.sideEffectClass !== "filesystem_mutation")
            return;
        const targets = snapshotTargets(call.arguments);
        for (const relativePath of targets) {
            const captured = await store.capture({ runId: context.runId, relativePath });
            if (!captured.ok) {
                await this.#record(context, "snapshot_unavailable", {
                    kind: "snapshot_unavailable",
                    toolCallId: call.providerToolCallId,
                    path: relativePath,
                    reason: captured.code,
                });
            }
        }
        // A single-file edit also gets an immediate snapshot. The whole-Run entry
        // above is first-wins per path and is meant for a user undo; it cannot restore
        // only the edit that just failed after an earlier success.
        if (this.#deps.syntaxChecker !== undefined && targets.length === 1) {
            const relativePath = targets[0];
            if (relativePath === undefined)
                return;
            const captured = await store.captureEdit({
                runId: context.runId,
                relativePath,
            });
            if (captured.ok) {
                context.editSnapshots.set(call.providerToolCallId, {
                    path: relativePath,
                    before: captured.entry,
                    afterSha256: null,
                    afterKnown: false,
                });
            }
            else {
                await this.#record(context, "snapshot_unavailable", {
                    kind: "snapshot_unavailable",
                    toolCallId: call.providerToolCallId,
                    path: relativePath,
                    reason: captured.code,
                });
            }
        }
    }
    /**
     * Replace an oversized result with a preview pointing at the stored copy.
     *
     * The spill file is keyed by the provider tool call id, so the event path and the
     * conversation path find the same file rather than writing it twice.
     *
     * A failed store keeps the text inline: spilling is an optimisation, and losing
     * the result because storage was unavailable would be worse than a large turn.
     */
    async #spillToolText(context, call, text) {
        if (text === null)
            return null;
        if (!exceedsSpillThreshold(text.length))
            return text;
        const store = this.#deps.spillStore;
        if (store === undefined)
            return text;
        const stored = await store.spill({
            toolCallId: call.providerToolCallId,
            toolName: call.toolName,
            text,
        });
        if (stored.reference === null)
            return text;
        const reference = stored.readable
            ? stored.reference
            : `${stored.reference} (outside the workspace; reading it needs approval)`;
        const spilled = spillToolOutput({ text, reference, toolName: call.toolName });
        if (spilled.kind === "inline")
            return text;
        await this.#record(context, "tool_output_spilled", {
            kind: "tool_output_spilled",
            toolCallId: call.providerToolCallId,
            providerToolCallId: call.providerToolCallId,
            toolName: call.toolName,
            totalUnits: text.length,
            previewUnits: spilled.preview.length,
            reference: stored.reference,
            readable: stored.readable,
        });
        return spilled.preview;
    }
    #record(context, type, payload) {
        return this.#serialize(context, () => this.#recordNow(context, type, payload));
    }
    #serialize(context, action) {
        const operation = context.eventTail.then(() => {
            if (this.#persistenceFailed)
                throw new Error("session_persistence_failed");
            return action();
        });
        context.eventTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async #appendEvent(context, input) {
        if (this.#persistenceFailed)
            throw new Error("session_persistence_failed");
        try {
            return await this.#deps.eventLog.append(input);
        }
        catch {
            // An append error may mean a partial durable write. Never resume writing or
            // dispatching from a projection whose relation to disk is now uncertain.
            this.#persistenceFailed = true;
            for (const affected of new Set([context, this.#activeContext])) {
                if (affected === null)
                    continue;
                affected.abortController.abort();
                affected.pendingApproval?.resolve();
                affected.pendingQuestion?.resolve();
                affected.pendingDisclosure?.resolve();
            }
            throw new Error("session_persistence_failed");
        }
    }
    async #recordNow(context, type, payload) {
        await this.#deps.refreshOwnedKeys?.();
        this.#accountTime(context);
        if (type === "tool_dispatch_committed" && context.elapsedExceeded)
            throw new Error("elapsed_limit");
        if (type === "tool_dispatch_committed" &&
            (context.cancelRequested ||
                context.events.some(({ payload: fact }) => fact.kind === "run_cancel_requested")))
            throw new Error("tool_cancelled");
        const input = {
            sessionId: context.sessionId,
            runId: context.runId,
            type,
            correlationId: context.correlationId,
            causationId: context.lastEventId,
            timestampUtc: this.#deps.nowUtc(),
            payload,
        };
        if (this.#deps.ownedKeys !== undefined)
            assertProtectedValue(this.#deps.ownedKeys, input);
        const budgetFact = {
            ...input,
            type: "run_budget_updated",
            payload: {
                kind: "run_budget_updated",
                budget: context.budget,
                costUnknown: context.costUnknown,
            },
        };
        if (this.#deps.ownedKeys !== undefined)
            assertProtectedValue(this.#deps.ownedKeys, budgetFact);
        const budgetEvent = await this.#appendEvent(context, budgetFact);
        context.events.push(budgetEvent);
        context.lastEventId = budgetEvent.eventId;
        await this.#maybeCheckpoint(context, budgetEvent);
        const event = await this.#appendEvent(context, { ...input, causationId: budgetEvent.eventId });
        context.events.push(event);
        context.lastEventId = event.eventId;
        await this.#maybeCheckpoint(context, event);
        if (this.#deps.persistReports === true &&
            context.events.some(({ payload }) => payload.kind === "run_started") &&
            [
                "run_completed",
                "run_failed",
                "run_cancelled",
                "run_waiting",
                "background_task_observed",
                "tool_execution_finished",
            ].includes(type)) {
            const derived = deriveTaskReport(context.events, context.sessionId, context.runId);
            if (!derived.ok)
                throw new Error("task_report_invalid");
            const reportInput = {
                ...input,
                type: "task_report_snapshot",
                causationId: event.eventId,
                payload: {
                    kind: "task_report_snapshot",
                    protocolRunState: context.run.state,
                    report: derived.value,
                },
            };
            if (this.#deps.ownedKeys !== undefined)
                assertProtectedValue(this.#deps.ownedKeys, reportInput);
            const reportEvent = await this.#appendEvent(context, reportInput);
            context.events.push(reportEvent);
            context.lastEventId = reportEvent.eventId;
            await this.#maybeCheckpoint(context, reportEvent);
        }
    }
    #nowMs() {
        const value = this.#deps.nowMs?.() ?? Date.parse(this.#deps.nowUtc());
        if (!Number.isFinite(value))
            throw new Error("clock_unavailable");
        return Math.floor(value);
    }
    #accountTime(context) {
        const now = this.#nowMs();
        const delta = Math.max(0, now - context.lastBudgetTick);
        if (context.accountingActive)
            context.budget = {
                ...context.budget,
                elapsedActiveMs: context.budget.elapsedActiveMs + delta,
            };
        context.lastBudgetTick = now;
        context.accountingActive = context.run.state === "active";
        if (context.budget.elapsedActiveMs >= RUN_BUDGET_LIMITS.elapsedActiveMs)
            context.elapsedExceeded = true;
        return context.elapsedExceeded;
    }
    #clearBudgetTimer(context) {
        if (context.budgetTimer !== null)
            clearTimeout(context.budgetTimer);
        context.budgetTimer = null;
    }
    #armBudgetTimer(context) {
        this.#clearBudgetTimer(context);
        const remaining = RUN_BUDGET_LIMITS.elapsedActiveMs - context.budget.elapsedActiveMs;
        context.budgetTimer = setTimeout(() => {
            context.elapsedExceeded = true;
            context.abortController.abort();
        }, Math.max(0, remaining));
        context.budgetTimer.unref();
    }
    /**
     * Checkpoint after the authoritative event write. A checkpoint failure is
     * recorded as a diagnostic fact only: it must never fail the Run or pretend
     * the event was not written.
     */
    async #maybeCheckpoint(context, event) {
        const store = this.#deps.checkpoints;
        if (store === undefined)
            return;
        let due;
        try {
            due = store.noteEvent(context.sessionId, event);
        }
        catch {
            context.checkpointFailure = "checkpoint_counter_failed";
            return;
        }
        if (!due)
            return;
        try {
            await store.write(context.sessionId, context.events);
        }
        catch {
            context.checkpointFailure = "checkpoint_write_failed";
        }
    }
    async #cancel(context) {
        if (context.run.state === "cancelled")
            return this.#result(context, "cancelled", null, "run_cancelled");
        const outstanding = new Map();
        for (const item of context.conversation) {
            if (item.kind === "assistant")
                for (const call of item.toolCalls)
                    outstanding.set(call.providerToolCallId, call);
            else if (item.kind === "tool_result")
                outstanding.delete(item.providerToolCallId);
        }
        const terminal = new Set();
        for (const { payload } of context.events) {
            if (payload.kind === "tool_execution_finished" ||
                payload.kind === "tool_execution_denied" ||
                payload.kind === "tool_call_cancelled")
                terminal.add(payload.toolCallId);
        }
        for (const { payload } of [...context.events]) {
            if (payload.kind !== "tool_call_received")
                continue;
            this.#deps.tools.discardApproval?.(payload.toolCallId);
            if (terminal.has(payload.toolCallId))
                continue;
            await this.#record(context, "tool_call_cancelled", {
                kind: "tool_call_cancelled",
                toolCallId: payload.toolCallId,
                providerToolCallId: payload.providerToolCallId,
                toolName: payload.toolName,
                reason: "run_cancelled",
            });
        }
        const cancelledCalls = new Set(context.events
            .slice(context.events.findLastIndex(({ payload }) => payload.kind === "model_response_validated"))
            .flatMap(({ payload }) => payload.kind === "tool_call_cancelled" && payload.providerToolCallId !== undefined
            ? [payload.providerToolCallId]
            : []));
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
            await this.#appendToolResult(context, call, "cancelled", "not_attempted: run cancelled");
        }
        const finished = finishRun(context.run, "cancelled");
        if (!finished.ok)
            return this.#fail(context, finished.code);
        context.run = finished.value;
        await this.#record(context, "run_cancelled", {
            kind: "run_cancelled",
            safeCode: "run_cancelled",
        });
        return this.#result(context, "cancelled", null, "run_cancelled");
    }
    async #fail(context, safeCode) {
        const finished = finishRun(context.run, "failed");
        if (finished.ok) {
            context.run = finished.value;
            await this.#record(context, "run_failed", { kind: "run_failed", safeCode });
        }
        return this.#result(context, "failed", null, safeCode);
    }
    async #blockDelivery(context, reason) {
        context.deliveryBlocked = true;
        const waitToken = this.#deps.ids.create();
        const waiting = waitRun(context.run, "recovery_review", waitToken, 1);
        if (waiting.ok)
            context.run = waiting.value;
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
        }
        catch (error) {
            // Short keys may collide with even the safe diagnostic vocabulary.
            // Withhold that record too; never fall back to unguarded persistence.
            if (!(error instanceof ProtectedDeliveryError))
                throw error;
        }
        return this.#result(context, "waiting", null, "protected_delivery_blocked");
    }
    #result(context, status, text, safeCode) {
        this.#clearBudgetTimer(context);
        if (status !== "waiting") {
            // Launch material and guidance updates are injected afresh at the next Run
            // boundary. Carrying them as history would duplicate the rules and, for
            // guidance, defeat the prefix cache on the next request.
            this.#conversation = context.conversation.filter((item) => !(item.kind === "user" && isLaunchMaterial(item.text)));
        }
        const result = {
            status,
            run: context.run,
            events: [...context.events],
            text,
            safeCode,
            ...(context.usage === undefined ? {} : { usage: context.usage }),
        };
        this.#lastResult = result;
        return result;
    }
    /**
     * Refuse a Run before it starts.
     *
     * No Run context exists yet, so this cannot write events. It returns a failed
     * result with the reason, which is honest: nothing was attempted and nothing was
     * recorded because there was no Run to record.
     */
    #refuseBeforeStart(safeCode) {
        // `run` rejects for pre-start problems, matching how it already reports a
        // closed session or a busy one. The reason is the safe code, not free text.
        return Promise.reject(new Error(safeCode));
    }
}
function sleep(delayMs, signal) {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted)
            finish();
    });
}
/**
 * Canonicalize tool arguments for fingerprinting: object keys are sorted so key
 * order cannot make two identical calls look different. This is a comparison
 * canonicalization, not a validation.
 */
function canonicalizeInput(value) {
    return stableStringify(value);
}
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "null";
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
/** Rough conversation size, matching the per-message estimator used elsewhere. */
function estimateConversationTokens(conversation) {
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
function renderArtifact(artifact) {
    const lines = [
        "[context-summary]",
        "note=this replaces earlier turns; claims without evidence are unverified",
        `coverage=${artifact.coverage.fromSeq}..${artifact.coverage.toSeq}`,
        `goal=${artifact.goal}`,
    ];
    for (const claim of artifact.completedClaims) {
        lines.push(`- claim(unverified): ${claim.text}`);
    }
    for (const reason of artifact.blockedReasons)
        lines.push(`- blocked: ${reason}`);
    for (const action of artifact.nextActions)
        lines.push(`- next: ${action}`);
    for (const file of artifact.fileReferences)
        lines.push(`- file: ${file}`);
    return lines.join("\n");
}
function hashText(text) {
    // Deterministic, non-cryptographic digest for event correlation only. The
    // authoritative integrity check is the event hash chain, not this value.
    let hash = 2_166_136_261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}
/**
 * Workspace-relative paths a mutating call will write.
 *
 * Each mutation tool names its targets differently; this reads the shapes the
 * catalog defines rather than guessing. A tool with an unrecognized argument shape
 * yields no targets, which means no snapshot and therefore no undo for that call -
 * reported through the absence of an entry, not silently claimed as safe.
 */
function snapshotTargets(args) {
    if (typeof args !== "object" || args === null)
        return [];
    const record = args;
    // create_file, edit_file, delete_path, rename_path: a single path.
    const single = record["path"];
    if (typeof single === "string" && single.length > 0)
        return [single];
    // apply_patch: one or more patch sections, each naming a file.
    const patch = record["patch"];
    if (typeof patch === "string")
        return patchTargets(patch);
    // Batch mutations: a list of targets.
    const targets = record["targets"];
    if (Array.isArray(targets)) {
        return targets.flatMap((entry) => {
            if (typeof entry === "string")
                return [entry];
            if (typeof entry === "object" && entry !== null) {
                const from = entry["from"];
                const to = entry["to"];
                return [from, to].filter((value) => typeof value === "string");
            }
            return [];
        });
    }
    return [];
}
/** Markers that identify per-Run launch material, not carried conversation. */
const LAUNCH_MATERIAL_MARKERS = [
    "[project-guidance]",
    "[project-guidance-update]",
    "[project-skill-catalog]",
    "[skill-activation]",
    "[mcp-catalog]",
];
function isLaunchMaterial(text) {
    return LAUNCH_MATERIAL_MARKERS.some((marker) => text.startsWith(marker));
}
/** File paths named by the patch markers the apply_patch tool accepts. */
function patchTargets(patch) {
    const found = [];
    for (const line of patch.split("\n")) {
        const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/u.exec(line.trim());
        const target = match?.[1]?.trim();
        if (target !== undefined && target.length > 0)
            found.push(target);
    }
    return found;
}
/**
 * An uncertain execution is unconfirmed rather than partial.
 *
 * "Partial" would claim knowledge of a result that arrived; "unconfirmed" says the
 * effect could not be established, which is the actual fact.
 */
function unconfirmedIfUnknown(status) {
    return status === "outcome_unknown" ? unconfirmed() : undefined;
}
