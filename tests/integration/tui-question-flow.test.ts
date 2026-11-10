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
import { createTuiController } from "../../src/tui/controller.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * The TUI must reflect the outcome after a reply.
 *
 * `coordinator.settle()` returns null for approval and question replies: it only
 * resolves ResumeRun continuations. The controller relied on it, so after the user
 * answered, the view stayed on the question and `lastResult()` never updated. These
 * tests pin the corrected behaviour for both replies.
 */

/** A read-only tool plus one that requires approval, so both paths are real. */
const MUTATING: ToolDefinition = {
  name: "create_file",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  requiresApproval: true,
  concurrencySafe: false,
};

const tools: ToolExecutor = {
  getDefinition: (name: string): ToolDefinition | null =>
    name === MUTATING.name ? MUTATING : null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #calls: { toolName: string; arguments: unknown }[];

  constructor(calls: readonly { toolName: string; arguments: unknown }[]) {
    this.#calls = [...calls];
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    const next = this.#calls.shift();
    if (next === undefined) {
      return { kind: "completed", toolCalls: [], text: "done" };
    }
    return {
      kind: "completed",
      toolCalls: [
        {
          providerToolCallId: `call-${this.requests.length}`,
          toolName: next.toolName,
          arguments: next.arguments,
        },
      ],
      text: null,
    };
  }
}

function build(calls: readonly { toolName: string; arguments: unknown }[]) {
  const ids = new SequenceIds("tui");
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(calls),
    tools,
    approvals: { decide: async () => "approved" },
    eventLog: new InMemoryEventLog(ids, new JsonDigest()),
    ids,
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: true,
  });
  return { controller: createTuiController({ coordinator }), coordinator };
}

const QUESTION_CALL = {
  toolName: "ask_user",
  arguments: {
    question: "Which file?",
    answerType: "choice",
    options: [
      { id: "a", label: "src/a.ts" },
      { id: "b", label: "src/b.ts" },
    ],
  },
};

describe("TUI question flow", () => {
  it("shows the pending question and completes after an answer", async () => {
    const { controller } = build([QUESTION_CALL]);

    const submit = controller.submit("pick a file");
    await new Promise((resolve) => setTimeout(resolve, 40));

    const waiting = controller.view();
    assert.equal(waiting.waitingKind, "question");
    assert.ok(waiting.pendingQuestion !== null);
    assert.equal(waiting.pendingQuestion?.options.length, 2);

    await controller.answer("a");
    await submit;

    const result = controller.lastResult();
    assert.ok(result !== null);
    assert.equal(result?.status, "completed");

    // The answer recorded is the label the user saw, not the bare id.
    const answered = result?.events.find((event) => event.payload.kind === "question_answered");
    assert.ok(answered);
    if (answered?.payload.kind !== "question_answered") return;
    assert.equal(answered.payload.answerText, "src/a.ts");

    // The view is no longer waiting.
    assert.equal(controller.view().runStatus, "completed");
    assert.equal(controller.view().waitingKind, null);
  });

  it("keeps waiting when no question is pending", async () => {
    const { controller } = build([]);
    await controller.submit("just answer");
    // Calling answer with nothing pending is a no-op, not a crash.
    await controller.answer("x");
    assert.equal(controller.lastResult()?.status, "completed");
  });
});

describe("TUI approval flow", () => {
  it("reflects the outcome after an approval reply", async () => {
    const { controller } = build([
      { toolName: "create_file", arguments: { path: "a.txt", content: "x" } },
    ]);

    const submit = controller.submit("make a file");
    await new Promise((resolve) => setTimeout(resolve, 40));

    const waiting = controller.view();
    assert.equal(waiting.waitingKind, "approval");
    assert.ok(waiting.pendingApproval !== null);
    assert.equal(waiting.runStatus, "waiting");
    assert.ok(
      waiting.pendingApprovalPreview !== null,
      "the recorded preview must reach the TUI before the Run promise settles",
    );

    await controller.deny();
    await submit;

    const result = controller.lastResult();
    assert.ok(result !== null);
    // A denial is a failed tool result, not a failed Run.
    assert.equal(result?.status, "completed");
    assert.ok(result?.events.some((event) => event.payload.kind === "tool_execution_denied"));
    assert.equal(controller.view().waitingKind, null);
  });
});

describe("TUI accepts a label answer", () => {
  it("completes when the user types the visible label", async () => {
    const { controller } = build([QUESTION_CALL]);
    const submit = controller.submit("pick a file");
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The panel shows "b) src/b.ts"; typing the label must work.
    await controller.answer("src/b.ts");
    await submit;

    const result = controller.lastResult();
    assert.equal(result?.status, "completed");
    const answered = result?.events.find((event) => event.payload.kind === "question_answered");
    assert.ok(answered);
    if (answered?.payload.kind !== "question_answered") return;
    assert.equal(answered.payload.answerText, "src/b.ts");
  });

  it("keeps the question open and reports why an answer was rejected", async () => {
    const { controller } = build([QUESTION_CALL]);
    const submit = controller.submit("pick a file");
    await new Promise((resolve) => setTimeout(resolve, 40));

    await controller.answer("nonexistent");
    // The Run must still be waiting, with an error surfaced.
    assert.equal(controller.view().waitingKind, "question");
    assert.match(controller.view().answerError ?? "", /nonexistent/);

    // A valid answer then completes it.
    await controller.answer("a");
    await submit;
    assert.equal(controller.lastResult()?.status, "completed");
  });
});
