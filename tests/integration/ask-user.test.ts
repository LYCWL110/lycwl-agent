import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import {
  type PendingQuestionView,
  RuntimeCoordinator,
} from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const QUESTION_CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "ask_user",
  arguments: {
    answerType: "choice",
    question: "Which target?",
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
  },
} as const;

function coordinatorWith(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly {
      providerToolCallId: string;
      toolName: string;
      arguments: unknown;
    }[];
    text: string | null;
  }[],
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools: new RecordingTools(false, { status: "succeeded", text: null }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
    suspendOnApproval: true,
  });
  return { digests, eventLog, coordinator };
}

async function waitForQuestion(coordinator: RuntimeCoordinator): Promise<PendingQuestionView> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const pending = coordinator.pendingQuestionView();
    if (pending !== null) return pending;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("question wait never became pending");
}

describe("ask_user suspended question", () => {
  it("waits for a typed answer and reports a succeeded tool result", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "used the answer" },
    ]);

    const running = coordinator.run("ask a question");
    const pending = await waitForQuestion(coordinator);
    assert.equal(pending.answerType, "choice");
    assert.equal(pending.question, "Which target?");
    assert.deepEqual(
      pending.options.map((option) => option.id),
      ["a", "b"],
    );

    assert.deepEqual(
      await coordinator.submitUserInput({
        commandId: "answer-1",
        questionId: pending.questionId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        answer: { kind: "choice", optionIds: ["b"] },
      }),
      { ok: true, duplicate: false },
    );

    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(result.text, "used the answer");
    const answered = result.events.find((event) => event.payload.kind === "question_answered");
    assert.equal(answered?.payload.kind, "question_answered");
    if (answered?.payload.kind !== "question_answered") return;
    // The recorded answer carries the label the user saw, not just the option id:
    // an id alone tells the model nothing about what was chosen.
    assert.equal(answered.payload.answerText, "Beta");
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
      false,
    );
  });

  it("rejects an invalid option without ending the wait", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const running = coordinator.run("ask with a bad answer");
    const pending = await waitForQuestion(coordinator);

    assert.deepEqual(
      await coordinator.submitUserInput({
        commandId: "bad-1",
        questionId: pending.questionId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        answer: { kind: "choice", optionIds: ["zzz"] },
      }),
      { ok: false, code: "invalid_option" },
    );
    assert.notEqual(coordinator.pendingQuestionView(), null);

    await coordinator.submitUserInput({
      commandId: "good-1",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: { kind: "choice", optionIds: ["a"] },
    });

    const result = await running;
    assert.equal(result.status, "completed");
  });

  it("rejects mismatched identities and stale versions", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const running = coordinator.run("identity checks");
    const pending = await waitForQuestion(coordinator);

    assert.deepEqual(
      await coordinator.submitUserInput({
        commandId: "c1",
        questionId: "wrong-question",
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
        answer: { kind: "choice", optionIds: ["a"] },
      }),
      { ok: false, code: "unknown_question" },
    );
    assert.deepEqual(
      await coordinator.submitUserInput({
        commandId: "c2",
        questionId: pending.questionId,
        toolCallId: "wrong-call",
        requestVersion: pending.requestVersion,
        answer: { kind: "choice", optionIds: ["a"] },
      }),
      { ok: false, code: "tool_call_mismatch" },
    );
    assert.deepEqual(
      await coordinator.submitUserInput({
        commandId: "c3",
        questionId: pending.questionId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion + 5,
        answer: { kind: "choice", optionIds: ["a"] },
      }),
      { ok: false, code: "stale_version" },
    );

    await coordinator.submitUserInput({
      commandId: "c4",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: { kind: "choice", optionIds: ["a"] },
    });
    await running;
  });

  it("treats a declined question as a failed tool result", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "continued after decline" },
    ]);

    const running = coordinator.run("decline path");
    const pending = await waitForQuestion(coordinator);
    assert.deepEqual(
      await coordinator.declineQuestion({
        commandId: "decline-1",
        questionId: pending.questionId,
        toolCallId: pending.toolCallId,
        requestVersion: pending.requestVersion,
      }),
      { ok: true, duplicate: false },
    );

    const result = await running;

    assert.equal(result.status, "completed");
    const declined = result.events.find((event) => event.payload.kind === "question_declined");
    assert.notEqual(declined, undefined);
    const finished = result.events.find(
      (event) =>
        event.payload.kind === "tool_execution_finished" &&
        event.payload.safeCode === "question_declined",
    );
    assert.notEqual(finished, undefined);
  });

  it("cancels only the question, not the Run", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "run continued" },
    ]);

    const running = coordinator.run("cancel question only");
    const pending = await waitForQuestion(coordinator);
    await coordinator.cancelQuestion({
      commandId: "cancel-1",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
    });

    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((event) => event.payload.kind === "run_cancelled"),
      false,
    );
    assert.notEqual(
      result.events.find((event) => event.payload.kind === "question_cancelled"),
      undefined,
    );
  });

  it("keeps waiting when the panel is closed", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const running = coordinator.run("close the panel");
    const pending = await waitForQuestion(coordinator);

    assert.deepEqual(await coordinator.closeQuestionView(pending.questionId), { ok: true });
    assert.notEqual(coordinator.pendingQuestionView(), null);
    assert.deepEqual(await coordinator.closeQuestionView("other-question"), { ok: false });

    await coordinator.submitUserInput({
      commandId: "after-close",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
      answer: { kind: "choice", optionIds: ["a"] },
    });
    const result = await running;

    assert.equal(result.status, "completed");
    assert.notEqual(
      result.events.find((event) => event.payload.kind === "question_view_closed"),
      undefined,
    );
  });

  it("reports an unavailable channel as a failed tool result", async () => {
    const { coordinator } = coordinatorWith([
      { kind: "completed", toolCalls: [QUESTION_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const running = coordinator.run("unavailable channel");
    const pending = await waitForQuestion(coordinator);
    await coordinator.markQuestionUnavailable({
      commandId: "unavailable-1",
      questionId: pending.questionId,
      toolCallId: pending.toolCallId,
      requestVersion: pending.requestVersion,
    });

    const result = await running;
    const unavailable = result.events.find(
      (event) => event.payload.kind === "question_unavailable",
    );
    assert.notEqual(unavailable, undefined);
  });

  it("fails the call before dispatch when the question shape is invalid", async () => {
    const { coordinator } = coordinatorWith([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "provider-call-bad",
            toolName: "ask_user",
            arguments: { answerType: "choice", question: "Q", options: [] },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const result = await coordinator.run("invalid question");

    assert.equal(result.status, "completed");
    const requested = result.events.find((event) => event.payload.kind === "question_requested");
    assert.equal(requested, undefined);
    assert.notEqual(
      result.events.find(
        (event) =>
          event.payload.kind === "tool_execution_finished" &&
          event.payload.safeCode === "invalid_question",
      ),
      undefined,
    );
  });
});
