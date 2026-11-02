import {
  type ApprovalGrant,
  commitToolDispatch,
  decideApproval,
  requestApproval,
} from "../../domain/approval/approval-state.ts";
import {
  receiveToolInvocation,
  type ToolInvocation,
  transitionToolInvocation,
} from "../../domain/tool-invocation/tool-invocation-state.ts";
import type { ApprovalGate } from "../../ports/approval-gate.ts";
import type { IdentifierFactory } from "../../ports/identity.ts";
import type { ProviderToolCall } from "../../ports/model-provider.ts";
import type { ToolExecutor } from "../../ports/tool-executor.ts";

export type ToolCallOutcome =
  | Readonly<{
      kind: "continue";
      providerToolCallId: string;
      toolName: string;
      status: "succeeded" | "failed" | "denied";
      text: string | null;
    }>
  | Readonly<{
      kind: "unknown";
      providerToolCallId: string;
      toolName: string;
      safeCode: string;
    }>
  | Readonly<{ kind: "invalid"; safeCode: string }>
  | Readonly<{
      kind: "waiting";
      toolCallId: string;
      approvalId: string;
      waitToken: string;
      requestVersion: number;
      call: ProviderToolCall;
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
  onEvent: (
    type:
      | "tool_call_received"
      | "approval_requested"
      | "approval_decided"
      | "tool_dispatch_committed"
      | "tool_execution_denied"
      | "tool_execution_started"
      | "tool_execution_finished",
    payload: unknown,
  ) => Promise<void>;
}>;

export async function executeToolCall(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  resume?: ApprovalResume,
): Promise<ToolCallOutcome> {
  const toolCallId = resume?.toolCallId ?? dependencies.ids.create();
  let invocation: ToolInvocation = { toolCallId, state: "received" };

  if (resume === undefined) {
    const received = receiveToolInvocation(toolCallId);
    if (!received.ok) return { kind: "invalid", safeCode: received.code };
    invocation = received.value;
    await dependencies.onEvent("tool_call_received", {
      kind: "tool_call_received",
      toolCallId,
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
    });

    const definition = dependencies.tools.getDefinition(call.toolName);
    if (definition === null) {
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

    if (definition.requiresApproval) {
      const awaiting = transitionToolInvocation(invocation, "awaiting_approval");
      if (!awaiting.ok) return { kind: "invalid", safeCode: awaiting.code };
      invocation = awaiting.value;
      const approvalId = dependencies.ids.create();
      const pending = requestApproval(approvalId, toolCallId);
      if (!pending.ok) return { kind: "invalid", safeCode: pending.code };
      await dependencies.onEvent("approval_requested", {
        kind: "approval_requested",
        approvalId,
        toolCallId,
        toolName: call.toolName,
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
        safePreview: `${call.toolName} in synthetic workspace`,
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

async function deniedOutcome(
  dependencies: ToolCallDependencies,
  call: ProviderToolCall,
  toolCallId: string,
): Promise<ToolCallOutcome> {
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

  const result = await dependencies.tools.execute({
    toolCallId,
    toolName: call.toolName,
    arguments: call.arguments,
  });
  const terminal = transitionToolInvocation(executing.value, result.status);
  if (!terminal.ok) return { kind: "invalid", safeCode: terminal.code };
  await dependencies.onEvent("tool_execution_finished", {
    kind: "tool_execution_finished",
    toolCallId,
    status: result.status,
    safeCode: result.status === "succeeded" ? null : result.safeCode,
    text: result.status === "outcome_unknown" ? null : result.text,
  });

  if (result.status === "outcome_unknown") {
    return {
      kind: "unknown",
      providerToolCallId: call.providerToolCallId,
      toolName: call.toolName,
      safeCode: "tool_outcome_unknown",
    };
  }
  return {
    kind: "continue",
    providerToolCallId: call.providerToolCallId,
    toolName: call.toolName,
    status: result.status,
    text: result.text,
  };
}
