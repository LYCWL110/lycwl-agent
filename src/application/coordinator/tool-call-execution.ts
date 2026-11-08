import {
  type ApprovalGrant,
  commitToolDispatch,
  decideApproval,
  requestApproval,
} from "../../domain/approval/approval-state.ts";
import {
  type AskUserQuestion,
  type QuestionOutcome,
  validateAskUserQuestion,
} from "../../domain/question/ask-user.ts";
import type { OwnedKeyRegistry } from "../../domain/security/owned-key-guard.ts";
import {
  receiveToolInvocation,
  type ToolInvocation,
  transitionToolInvocation,
} from "../../domain/tool-invocation/tool-invocation-state.ts";
import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type { ProviderToolCall } from "../../ports/model-provider.ts";
import type { ToolExecutor } from "../../ports/tool-executor.ts";
import { guardToolResultText } from "../../services/security/guarded-delivery.ts";

export type ToolCallOutcome =
  | Readonly<{
      kind: "continue";
      providerToolCallId: string;
      toolName: string;
      status: "succeeded" | "failed" | "denied";
      text: string | null;
      deliveryBlocked?: boolean;
      deliveryBlockReason?: "owned_key_detected" | "guard_failure";
    }>
  | Readonly<{
      kind: "unknown";
      providerToolCallId: string;
      toolName: string;
      safeCode: string;
      deliveryBlocked?: boolean;
      deliveryBlockReason?: "owned_key_detected" | "guard_failure";
    }>
  | Readonly<{ kind: "invalid"; safeCode: string }>
  | Readonly<{
      kind: "waiting";
      toolCallId: string;
      approvalId: string;
      waitToken: string;
      requestVersion: number;
      call: ProviderToolCall;
    }>
  | Readonly<{
      kind: "question_waiting";
      toolCallId: string;
      questionId: string;
      waitToken: string;
      requestVersion: number;
      question: AskUserQuestion;
      call: ProviderToolCall;
    }>;

export const ASK_USER_TOOL = "ask_user";

export type QuestionResume = Readonly<{
  toolCallId: string;
  questionId: string;
  waitToken: string;
  requestVersion: number;
  outcome: QuestionOutcome;
}>;

export type ApprovalResume = Readonly<{
  toolCallId: string;
  approvalId: string;
  waitToken: string;
  requestVersion: number;
  decision: "approved" | "denied";
}>;

export type ToolCallDependencies = Readonly<{
  tools: ToolExecutor;
  approvals: ApprovalGate;
  ids: IdentifierFactory;
  /** When true, an approval request suspends the call instead of deciding inline. */
  deferApprovals?: boolean;
  /** When true, ask_user suspends the call until a matching answer arrives. */
  deferQuestions?: boolean;
  /** C10 owned-key registry applied to persisted tool result text. */
  ownedKeys?: OwnedKeyRegistry;
  refreshOwnedKeys?: () => Promise<void>;
  signal?: AbortSignal;
  onEvent: (
    type:
      | "tool_call_received"
      | "approval_requested"
      | "approval_decided"
      | "approval_grant_revoked"
      | "tool_dispatch_committed"
      | "tool_execution_denied"
      | "tool_execution_started"
      | "tool_execution_finished"
      | "question_requested"
      | "question_answered"
      | "question_declined"
      | "question_cancelled"
      | "question_unavailable",
    payload: unknown,
  ) => Promise<void>;
}>;

export async function executeToolCall(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  resume?: ApprovalResume | QuestionResume,
): Promise<ToolCallOutcome> {
  const toolCallId = resume?.toolCallId ?? dependencies.ids.create();
  let invocation: ToolInvocation = { toolCallId, state: "received" };

  if (resume !== undefined && "outcome" in resume) {
    return finishQuestion(dependencies, call, resume);
  }

  if (resume === undefined) {
    const received = receiveToolInvocation(toolCallId);
    if (!received.ok) return { kind: "invalid", safeCode: received.code };
    invocation = received.value;
    await dependencies.onEvent("tool_call_received", {
      kind: "tool_call_received",
      toolCallId,
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      // Recorded so a restart can rebuild this call's input.
      arguments: call.arguments,
    });

    // `ask_user` is handled by the coordinator itself and has no tool executor, so
    // it must not be required to register a definition. Checking the definition
    // first is what previously made the model unable to ask anything: the lookup
    // returned null and the call failed as `unknown_tool` before this branch ran.
    const definition =
      call.toolName === ASK_USER_TOOL ? null : dependencies.tools.getDefinition(call.toolName);
    if (call.toolName !== ASK_USER_TOOL && definition === null) {
      await dependencies.onEvent("tool_execution_finished", {
        kind: "tool_execution_finished",
        toolCallId,
        status: "failed",
        safeCode: "unknown_tool",
        text: null,
      });
      return {
        kind: "continue",
        providerToolCallId: call.providerToolCallId,
        toolName: call.toolName,
        status: "failed",
        text: null,
      };
    }

    const validated = transitionToolInvocation(invocation, "validated");
    if (!validated.ok) return { kind: "invalid", safeCode: validated.code };
    invocation = validated.value;

    if (call.toolName === ASK_USER_TOOL) {
      const question = validateAskUserQuestion(call.arguments);
      if (!question.ok) {
        await dependencies.onEvent("tool_execution_finished", {
          kind: "tool_execution_finished",
          toolCallId,
          status: "failed",
          safeCode: question.code,
          text: null,
        });
        return {
          kind: "continue",
          providerToolCallId: call.providerToolCallId,
          toolName: call.toolName,
          status: "failed",
          text: null,
        };
      }
      const questionId = dependencies.ids.create();
      await dependencies.onEvent("question_requested", {
        kind: "question_requested",
        questionId,
        toolCallId,
        question: question.question.question,
        answerType: question.question.answerType,
        waitToken: questionId,
        requestVersion: 1,
      });
      if (dependencies.deferQuestions !== true) {
        return { kind: "invalid", safeCode: "question_requires_interaction" };
      }
      return {
        kind: "question_waiting",
        toolCallId,
        questionId,
        waitToken: questionId,
        requestVersion: 1,
        question: question.question,
        call,
      };
    }

    // `ask_user` returned above, so reaching here means the tool has a definition.
    const dynamicApproval = await dependencies.tools.requiresApproval?.({
      toolCallId,
      toolName: call.toolName,
      arguments: call.arguments,
    });
    if (definition?.requiresApproval || dynamicApproval === true) {
      const awaiting = transitionToolInvocation(invocation, "awaiting_approval");
      if (!awaiting.ok) return { kind: "invalid", safeCode: awaiting.code };
      invocation = awaiting.value;
      const approvalId = dependencies.ids.create();
      const pending = requestApproval(approvalId, toolCallId);
      if (!pending.ok) return { kind: "invalid", safeCode: pending.code };
      const safePreview = await resolvePreview(dependencies, call, toolCallId);
      if (safePreview === null) return previewFailure(dependencies, call, toolCallId);
      await dependencies.onEvent("approval_requested", {
        kind: "approval_requested",
        approvalId,
        toolCallId,
        toolName: call.toolName,
        safePreview,
      });

      if (dependencies.deferApprovals === true) {
        return {
          kind: "waiting",
          toolCallId,
          approvalId,
          waitToken: approvalId,
          requestVersion: 1,
          call,
        };
      }

      const decision = await dependencies.approvals.decide({
        approvalId,
        toolCallId,
        toolName: call.toolName,
        safePreview,
      });
      const decided = decideApproval(pending.value, decision);
      if (!decided.ok) return { kind: "invalid", safeCode: decided.code };
      await dependencies.onEvent("approval_decided", {
        kind: "approval_decided",
        approvalId,
        toolCallId,
        decision,
      });
      if (decision === "denied") {
        return deniedOutcome(dependencies, call, toolCallId);
      }
      return dispatchAndExecute(dependencies, call, toolCallId, invocation, approvalId);
    }

    return dispatchAndExecute(dependencies, call, toolCallId, invocation, null);
  }

  invocation = { toolCallId, state: "awaiting_approval" };
  if (resume.decision === "denied") {
    return deniedOutcome(dependencies, call, toolCallId);
  }
  return dispatchAndExecute(dependencies, call, toolCallId, invocation, resume.approvalId);
}

/**
 * Record the terminal question fact and map it to a tool result. An answered
 * question succeeds; decline/unavailable fail; cancel is a tool cancellation.
 * None of these is approval or disclosure consent.
 */
async function finishQuestion(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  resume: QuestionResume,
): Promise<ToolCallOutcome> {
  const { outcome } = resume;
  if (outcome.status === "answered") {
    await dependencies.onEvent("question_answered", {
      kind: "question_answered",
      questionId: resume.questionId,
      toolCallId: resume.toolCallId,
      answerText: outcome.text,
    });
  } else if (outcome.status === "declined") {
    await dependencies.onEvent("question_declined", {
      kind: "question_declined",
      questionId: resume.questionId,
      toolCallId: resume.toolCallId,
    });
  } else if (outcome.status === "cancelled") {
    await dependencies.onEvent("question_cancelled", {
      kind: "question_cancelled",
      questionId: resume.questionId,
      toolCallId: resume.toolCallId,
    });
  } else {
    await dependencies.onEvent("question_unavailable", {
      kind: "question_unavailable",
      questionId: resume.questionId,
      toolCallId: resume.toolCallId,
    });
  }

  await dependencies.onEvent("tool_execution_finished", {
    kind: "tool_execution_finished",
    toolCallId: resume.toolCallId,
    status: outcome.toolStatus,
    safeCode: outcome.toolStatus === "succeeded" ? null : outcome.safeCode,
    text: outcome.toolStatus === "succeeded" ? outcome.text : null,
  });

  if (outcome.toolStatus === "cancelled") {
    return {
      kind: "continue",
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      status: "failed",
      text: null,
    };
  }
  return {
    kind: "continue",
    providerToolCallId: call.providerToolCallId,
    toolName: call.toolName,
    status: outcome.toolStatus,
    text: outcome.toolStatus === "succeeded" ? outcome.text : null,
  };
}

async function resolvePreview(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  toolCallId: string,
): Promise<string | null> {
  const preview = dependencies.tools.preview;
  if (preview === undefined) return `${call.toolName} in synthetic workspace`;
  try {
    const rendered = await preview.call(dependencies.tools, {
      toolCallId,
      toolName: call.toolName,
      arguments: call.arguments,
    });
    return rendered ?? `${call.toolName} in synthetic workspace`;
  } catch {
    // A broken preview must not silently authorize the operation.
    return null;
  }
}

async function previewFailure(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  toolCallId: string,
): Promise<ToolCallOutcome> {
  dependencies.tools.discardApproval?.(toolCallId);
  await dependencies.onEvent("tool_execution_finished", {
    kind: "tool_execution_finished",
    toolCallId,
    status: "failed",
    safeCode: "preview_unavailable",
    text: null,
  });
  return {
    kind: "continue",
    providerToolCallId: call.providerToolCallId,
    toolName: call.toolName,
    status: "failed",
    text: null,
  };
}

async function deniedOutcome(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  toolCallId: string,
): Promise<ToolCallOutcome> {
  dependencies.tools.discardApproval?.(toolCallId);
  const denied = transitionToolInvocation({ toolCallId, state: "awaiting_approval" }, "denied");
  if (!denied.ok) return { kind: "invalid", safeCode: denied.code };
  await dependencies.onEvent("tool_execution_denied", {
    kind: "tool_execution_denied",
    toolCallId,
    toolName: call.toolName,
  });
  return {
    kind: "continue",
    providerToolCallId: call.providerToolCallId,
    toolName: call.toolName,
    status: "denied",
    text: null,
  };
}

async function dispatchAndExecute(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  toolCallId: string,
  invocation: ToolInvocation,
  approvalId: string | null,
): Promise<ToolCallOutcome> {
  const request = {
    toolCallId,
    toolName: call.toolName,
    arguments: call.arguments,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    approvalGranted: approvalId !== null,
  };
  if (dependencies.signal?.aborted) return { kind: "invalid", safeCode: "tool_cancelled" };
  if (approvalId !== null && dependencies.tools.revalidateApproval !== undefined) {
    let unchanged = false;
    try {
      unchanged = await dependencies.tools.revalidateApproval(request);
    } catch {
      /* Reapproval fails closed. */
    }
    if (!unchanged) {
      await dependencies.onEvent("approval_grant_revoked", {
        kind: "approval_grant_revoked",
        approvalId,
        toolCallId,
        reason: "precondition_changed",
      });
      const freshApprovalId = dependencies.ids.create();
      const safePreview = await resolvePreview(dependencies, call, toolCallId);
      if (safePreview === null) return previewFailure(dependencies, call, toolCallId);
      await dependencies.onEvent("approval_requested", {
        kind: "approval_requested",
        approvalId: freshApprovalId,
        toolCallId,
        toolName: call.toolName,
        safePreview,
      });
      if (dependencies.deferApprovals === true) {
        return {
          kind: "waiting",
          toolCallId,
          approvalId: freshApprovalId,
          waitToken: freshApprovalId,
          requestVersion: 1,
          call,
        };
      }
      const decision = await dependencies.approvals.decide({
        approvalId: freshApprovalId,
        toolCallId,
        toolName: call.toolName,
        safePreview,
      });
      await dependencies.onEvent("approval_decided", {
        kind: "approval_decided",
        approvalId: freshApprovalId,
        toolCallId,
        decision,
      });
      if (decision === "denied") return deniedOutcome(dependencies, call, toolCallId);
      return dispatchAndExecute(dependencies, call, toolCallId, invocation, freshApprovalId);
    }
  }
  if (dependencies.signal?.aborted) return { kind: "invalid", safeCode: "tool_cancelled" };
  const grant: ApprovalGrant | null =
    approvalId === null ? null : { approvalId, state: "available" };
  const dispatchId = dependencies.ids.create();
  const committed = commitToolDispatch(grant, { dispatchId, toolCallId, approvalId });
  if (!committed.ok) return { kind: "invalid", safeCode: committed.code };
  await dependencies.onEvent("tool_dispatch_committed", {
    kind: "tool_dispatch_committed",
    dispatchId,
    toolCallId,
    approvalId,
  });

  const ready = transitionToolInvocation(invocation, "ready");
  if (!ready.ok) return { kind: "invalid", safeCode: ready.code };
  const executing = transitionToolInvocation(ready.value, "executing");
  if (!executing.ok) return { kind: "invalid", safeCode: executing.code };
  await dependencies.onEvent("tool_execution_started", {
    kind: "tool_execution_started",
    toolCallId,
    toolName: call.toolName,
  });

  if (dependencies.signal?.aborted) return { kind: "invalid", safeCode: "tool_cancelled" };
  const result = await dependencies.tools.execute(request);
  const terminal = transitionToolInvocation(executing.value, result.status);
  if (!terminal.ok) return { kind: "invalid", safeCode: terminal.code };
  // C10: the persisted tool result is a protected exit too. A blocked text is
  // withheld from the event while the real status is preserved.
  const registry = dependencies.ownedKeys;
  await dependencies.refreshOwnedKeys?.();
  const delivery =
    result.deliveryBlocked !== undefined
      ? { text: null, deliveryBlocked: true as const, reason: result.deliveryBlocked }
      : registry === undefined
        ? { text: result.text ?? null, deliveryBlocked: false as const }
        : guardToolResultText(registry, result.status, result.text ?? null);
  await dependencies.onEvent("tool_execution_finished", {
    kind: "tool_execution_finished",
    toolCallId,
    status: result.status,
    safeCode: result.status === "succeeded" ? null : result.safeCode,
    text: delivery.text,
    toolName: call.toolName,
  });

  if (result.status === "outcome_unknown") {
    return {
      kind: "unknown",
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      safeCode: "tool_outcome_unknown",
      deliveryBlocked: delivery.deliveryBlocked,
      ...(delivery.deliveryBlocked ? { deliveryBlockReason: delivery.reason } : {}),
    };
  }
  return {
    kind: "continue",
    providerToolCallId: call.providerToolCallId,
    toolName: call.toolName,
    status: result.status,
    text: delivery.text,
    deliveryBlocked: delivery.deliveryBlocked,
    ...(delivery.deliveryBlocked ? { deliveryBlockReason: delivery.reason } : {}),
  };
}
