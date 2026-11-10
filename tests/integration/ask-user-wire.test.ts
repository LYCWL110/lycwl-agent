import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * `ask_user` is answered by the coordinator, not by a tool executor.
 *
 * The earlier ordering checked `getDefinition` first, so the lookup returned null
 * and the call failed as `unknown_tool` before the ask_user branch could run. A
 * model could therefore never ask a question in a real session, though the demo
 * runtime made it look like it worked.
 */

const noTools: ToolExecutor = {
  getDefinition: (): ToolDefinition | null => null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

class AskingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      return { kind: "completed", toolCalls: [], text: "thanks" };
    }
    return {
      kind: "completed",
      toolCalls: [
        {
          providerToolCallId: "call-1",
          toolName: "ask_user",
          arguments: {
            question: "Which file?",
            answerType: "choice",
            options: [
              { id: "a", label: "src/a.ts" },
              { id: "b", label: "src/b.ts" },
            ],
          },
        },
      ],
      text: null,
    };
  }
}

function coordinator(provider: ModelProvider) {
  return new RuntimeCoordinator({
    provider,
    tools: noTools,
    approvals: { decide: async () => "approved" },
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    ids: new SequenceIds(),
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: true,
  });
}

describe("ask_user without a registered tool definition", () => {
  it("suspends on the question instead of failing as unknown_tool", async () => {
    const provider = new AskingProvider();
    const underTest = coordinator(provider);

    const run = underTest.run("pick a file");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The question must be pending, not a failed tool call.
    const pending = underTest.pendingQuestionView();
    assert.ok(pending !== null, "the Run must wait on the question");
    if (pending === null) return;
    assert.equal(pending.question, "Which file?");
    assert.equal(pending.answerType, "choice");
    assert.equal(pending.options.length, 2);

    await underTest.submitUserInput({
      commandId: "cmd-1",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: { kind: "choice", optionIds: ["a"] },
    });

    const settled = (await underTest.settle()) ?? (await run);
    assert.equal(settled.status, "completed", settled.safeCode ?? "");

    // The answer reaches the model as a tool result, not as an approval.
    const second = provider.requests[1];
    assert.ok(second);
    const answerItem = second.conversation.find(
      (item) => item.kind === "tool_result" && item.providerToolCallId === "call-1",
    );
    assert.ok(answerItem, "the answer must come back as a tool result");
    if (answerItem?.kind !== "tool_result") return;
    assert.equal(answerItem.status, "succeeded");
    assert.match(answerItem.text ?? "", /src\/a\.ts/);

    // No approval was requested or granted for asking a question.
    assert.equal(
      settled.events.some((event) => event.payload.kind === "approval_requested"),
      false,
      "a question is not an approval",
    );
  });

  it("reports a rejected argument as a failed tool call", async () => {
    class BadProvider implements ModelProvider {
      readonly requests: ProviderRequest[] = [];
      async complete(): Promise<ProviderCompletion> {
        this.requests.push({ modelRequestId: "r", attemptNo: 1, conversation: [] });
        if (this.requests.length > 1) {
          return { kind: "completed", toolCalls: [], text: "ok" };
        }
        return {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: "call-1",
              toolName: "ask_user",
              arguments: { question: "x", answerType: "choice" },
            },
          ],
          text: null,
        };
      }
    }
    const result = await coordinator(new BadProvider()).run("ask badly");

    const finished = result.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished.length, 1);
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.status, "failed");
    assert.equal(result.status, "completed");
  });

  it("still rejects a genuinely unknown tool", async () => {
    class UnknownProvider implements ModelProvider {
      readonly requests: ProviderRequest[] = [];
      async complete(): Promise<ProviderCompletion> {
        this.requests.push({ modelRequestId: "r", attemptNo: 1, conversation: [] });
        if (this.requests.length > 1) {
          return { kind: "completed", toolCalls: [], text: "ok" };
        }
        return {
          kind: "completed",
          toolCalls: [{ providerToolCallId: "call-1", toolName: "no_such_tool", arguments: {} }],
          text: null,
        };
      }
    }
    const result = await coordinator(new UnknownProvider()).run("call nothing");

    const finished = result.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.safeCode, "unknown_tool");
  });
});
