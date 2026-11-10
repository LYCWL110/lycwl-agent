import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodoTool } from "../../src/adapters/tools/todo-tool.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { emptyTodoList, type TodoList } from "../../src/domain/planning/todo.ts";
import {
  JsonDigest,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

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
  let list: TodoList = emptyTodoList();
  const todo = createTodoTool({
    getList: () => list,
    setList: (next) => {
      list = next;
    },
  });
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools: todo,
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { digests, eventLog, coordinator, current: () => list };
}

const TODO_CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "todo",
  arguments: {
    items: [
      { id: "t1", content: "Inspect", state: "completed" },
      { id: "t2", content: "Fix", state: "in_progress" },
    ],
  },
};

describe("todo through the Runtime", () => {
  it("records the accepted list as an event", async () => {
    const { coordinator, current } = coordinatorWith([
      { kind: "completed", toolCalls: [TODO_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "planned" },
    ]);

    const result = await coordinator.run("plan the work");

    assert.equal(result.status, "completed");
    assert.equal(current().items.length, 2);
    const recorded = result.events.find((event) => event.payload.kind === "todo_replaced");
    assert.equal(recorded?.payload.kind, "todo_replaced");
    if (recorded?.payload.kind !== "todo_replaced") return;
    assert.equal(recorded.payload.revision, 1);
    assert.deepEqual(
      recorded.payload.items.map((item) => item.state),
      ["completed", "in_progress"],
    );
  });

  it("does not record or mutate the list when validation fails", async () => {
    const { coordinator, current } = coordinatorWith([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "provider-call-bad",
            toolName: "todo",
            arguments: {
              items: [
                { id: "t1", content: "a", state: "in_progress" },
                { id: "t2", content: "b", state: "in_progress" },
              ],
            },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "reported" },
    ]);

    const result = await coordinator.run("invalid plan");

    assert.equal(result.status, "completed");
    assert.equal(current().items.length, 0);
    assert.equal(
      result.events.some((event) => event.payload.kind === "todo_replaced"),
      false,
    );
    const failed = result.events.find(
      (event) =>
        event.payload.kind === "tool_execution_finished" &&
        event.payload.safeCode === "multiple_in_progress",
    );
    assert.notEqual(failed, undefined);
  });

  it("keeps todo state out of verification evidence", async () => {
    const { coordinator, digests, eventLog } = coordinatorWith([
      { kind: "completed", toolCalls: [TODO_CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);

    const result = await coordinator.run("plan only");
    assert.equal(result.status, "completed");

    const replayed = await replayRun(
      await eventLog.read(result.events[0]?.sessionId ?? ""),
      digests,
    );
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    // Completing a Run is not the same as verifying the planned work.
    assert.equal(replayed.value.state, "completed");
    assert.deepEqual(replayed.value.uncertainDispatches, []);
  });
});
