import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

function build(
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
  const ids = new SequenceIds("tui");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const provider = new ScriptedProvider(responses);
  const coordinator = new RuntimeCoordinator({
    provider: {
      complete: (request) =>
        provider.complete({
          ...request,
          conversation: structuredClone(request.conversation),
        }),
    },
    tools: new RecordingTools(false, { status: "succeeded", text: "tool output" }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { controller: createTuiController({ coordinator }), eventLog, provider };
}

describe("TUI controller", () => {
  it("shows queued messages while thinking and changes to sent only after a matching reply", async () => {
    const ids = new SequenceIds("queued-ui");
    const eventLog = new InMemoryEventLog(ids, new JsonDigest());
    const releases: Array<() => void> = [];
    const requests: string[][] = [];
    const coordinator = new RuntimeCoordinator({
      provider: {
        async complete(request) {
          requests.push(request.conversation.map((turn) => turn.text ?? ""));
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          return { kind: "completed", toolCalls: [], text: `reply-${requests.length}` };
        },
      },
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog,
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
    });
    const controller = createTuiController({ coordinator });
    const run = controller.submit("first");
    for (let index = 0; index < 100 && releases.length === 0; index++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 1);
    assert.equal(await controller.submit("second"), true);
    assert.equal(await controller.submit("third"), true);
    assert.deepEqual(
      controller
        .view()
        .transcript.filter((entry) => entry.kind === "user")
        .map((entry) => [entry.text, entry.status]),
      [
        ["first", null],
        ["second", "queued"],
        ["third", "queued"],
      ],
    );
    releases[0]?.();
    for (let index = 0; index < 100 && releases.length < 2; index++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    assert.ok(requests[1]?.includes("second") && requests[1]?.includes("third"));
    assert.deepEqual(
      controller
        .view()
        .transcript.filter((entry) => entry.kind === "user")
        .map((entry) => entry.status),
      [null, "sending", "sending"],
    );
    releases[1]?.();
    await run;
    assert.deepEqual(
      controller
        .view()
        .transcript.filter((entry) => entry.kind === "user")
        .map((entry) => entry.status),
      [null, "sent", "sent"],
    );
    assert.equal(controller.view().transcript.length, 5);
  });

  it("reports queue limits and preserves a rejected input as draft", async () => {
    const ids = new SequenceIds("queue-limit-ui");
    const coordinator = new RuntimeCoordinator({
      provider: { complete: () => new Promise(() => {}) },
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
    });
    const controller = createTuiController({ coordinator });
    const run = controller.submit("first");
    await new Promise((resolve) => setImmediate(resolve));
    const text = "x".repeat(16_001);
    assert.equal(await controller.submit(text), false);
    assert.equal(controller.view().draft, text);
    assert.match(controller.view().commandNotice ?? "", /input_too_long/);
    assert.equal(
      controller.view().transcript.some((entry) => entry.text === text),
      false,
    );
    await controller.cancelRun();
    await run;
  });
  it("starts idle and submits a task as a new run", async () => {
    const { controller } = build([{ kind: "completed", toolCalls: [], text: "done" }]);

    assert.equal(controller.view().runStatus, "idle");
    await controller.submit("fix the bug");

    assert.equal(controller.view().runStatus, "completed");
    assert.equal(controller.lastResult()?.status, "completed");
  });

  it("ignores an empty submission without starting a run", async () => {
    const { controller } = build([]);
    await controller.submit("   ");
    assert.equal(controller.view().runStatus, "idle");
    assert.equal(controller.lastResult(), null);
  });

  it("does not treat a panel action as a decision", async () => {
    const { controller } = build([]);
    await controller.approve();
    await controller.deny();
    await controller.answer("text");
    await controller.declineQuestion();
    assert.equal(controller.lastResult(), null);
    assert.equal(controller.view().pendingApproval, null);
  });

  it("ignores cancellation when no run is active", async () => {
    const { controller } = build([]);
    await controller.cancelRun();
    assert.equal(controller.view().runStatus, "idle");
    assert.equal(controller.lastResult(), null);
  });

  it("exposes the derived transcript after a run", async () => {
    const { controller } = build([{ kind: "completed", toolCalls: [], text: "finished" }]);

    await controller.submit("do work");

    const view = controller.view();
    assert.equal(
      view.transcript.some((entry) => entry.kind === "user" && entry.text === "do work"),
      true,
    );
    assert.equal(
      view.transcript.some((entry) => entry.kind === "assistant" && entry.text === "finished"),
      true,
    );
  });

  it("keeps all three turns visible and sends earlier replies with each new task", async () => {
    const { controller, provider, eventLog } = build([
      { kind: "completed", toolCalls: [], text: "I will remember seven" },
      { kind: "completed", toolCalls: [], text: "The number is seven" },
      { kind: "completed", toolCalls: [], text: "Seven plus one is eight" },
    ]);
    await controller.submit("remember seven");
    await controller.submit("what number?");
    await controller.submit("add one");
    assert.deepEqual(
      controller.view().transcript.map((entry) => entry.text),
      [
        "remember seven",
        "I will remember seven",
        "what number?",
        "The number is seven",
        "add one",
        "Seven plus one is eight",
      ],
    );
    assert.deepEqual(provider.requests[1]?.conversation, [
      { kind: "user", text: "remember seven" },
      { kind: "assistant", text: "I will remember seven", toolCalls: [] },
      { kind: "user", text: "what number?" },
    ]);
    const third = provider.requests[2]?.conversation;
    assert.ok(third);
    assert.equal(third[0]?.text, "remember seven");
    assert.equal(third[3]?.text, "The number is seven");
    assert.equal(third[4]?.text, "add one");
    const runEvents = controller.lastResult()?.events ?? [];
    const first = runEvents[0];
    assert.ok(first);
    const session = await eventLog.read(first.sessionId);
    assert.equal(session.filter((event) => event.type === "run_started").length, 3);
    assert.equal(new Set(session.map((event) => event.runId)).size, 3);
    assert.equal(
      controller.view().transcript.length,
      6,
      "reading the view must not duplicate entries",
    );
  });

  it("retains the previous transcript while the next response is still in flight", async () => {
    const ids = new SequenceIds("live-tui");
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const coordinator = new RuntimeCoordinator({
      provider: {
        async complete() {
          count += 1;
          if (count === 2) await waiting;
          return { kind: "completed", toolCalls: [], text: `reply-${count}` };
        },
      },
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-06T00:00:00.000Z",
    });
    const controller = createTuiController({ coordinator });
    await controller.submit("first");
    const next = controller.submit("second");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.view().runStatus, "active");
    assert.deepEqual(
      controller.view().transcript.map((entry) => entry.text),
      ["first", "reply-1", "second"],
    );
    release?.();
    await next;
    assert.deepEqual(
      controller.view().transcript.map((entry) => entry.text),
      ["first", "reply-1", "second", "reply-2"],
    );
  });

  it("carries a complete tool round and its final answer into the next user turn", async () => {
    const { controller, provider } = build([
      {
        kind: "completed",
        toolCalls: [
          { providerToolCallId: "call-1", toolName: "write_note", arguments: { text: "seven" } },
        ],
        text: "I will check",
      },
      { kind: "completed", toolCalls: [], text: "The result is seven" },
      { kind: "completed", toolCalls: [], text: "Still seven" },
    ]);
    await controller.submit("check the number");
    await controller.submit("what was the result?");
    const history = provider.requests[2]?.conversation;
    assert.ok(history);
    assert.deepEqual(history.slice(0, 5), [
      { kind: "user", text: "check the number" },
      {
        kind: "assistant",
        text: "I will check",
        toolCalls: [
          { providerToolCallId: "call-1", toolName: "write_note", arguments: { text: "seven" } },
        ],
      },
      {
        kind: "tool_result",
        providerToolCallId: "call-1",
        toolName: "write_note",
        status: "succeeded",
        text: "tool output",
      },
      { kind: "assistant", text: "The result is seven", toolCalls: [] },
      { kind: "user", text: "what was the result?" },
    ]);
  });

  it("restores the todo list from todo_replaced events", async () => {
    const { controller } = build([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "p1",
            toolName: "todo",
            arguments: {
              items: [{ id: "t1", content: "Plan", state: "in_progress" }],
            },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    await controller.submit("plan the work");

    const todo = controller.view().todo;
    assert.notEqual(todo, null);
    assert.equal(todo?.items.length, 1);
    assert.equal(todo?.items[0]?.content, "Plan");
  });
});
