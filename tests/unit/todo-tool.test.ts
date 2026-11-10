import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTodoTool, TODO_DEFINITION } from "../../src/adapters/tools/todo-tool.ts";
import { emptyTodoList, type TodoList } from "../../src/domain/planning/todo.ts";

function tool() {
  let list: TodoList = emptyTodoList();
  return {
    executor: createTodoTool({
      getList: () => list,
      setList: (next) => {
        list = next;
      },
    }),
    current: () => list,
  };
}

describe("todo tool executor", () => {
  it("exposes only the todo definition and is approval-free", () => {
    const { executor } = tool();
    assert.deepEqual(executor.getDefinition("todo"), TODO_DEFINITION);
    assert.equal(TODO_DEFINITION.requiresApproval, false);
    assert.equal(executor.getDefinition("write_note"), null);
  });

  it("replaces the list and reports the new revision", async () => {
    const { executor, current } = tool();
    const result = await executor.execute({
      toolCallId: "call-1",
      toolName: "todo",
      arguments: {
        items: [
          { id: "t1", content: "Inspect", state: "completed" },
          { id: "t2", content: "Fix", state: "in_progress" },
        ],
      },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /revision=1/);
    assert.equal(current().items.length, 2);
    assert.equal(current().revision, 1);
  });

  it("does not mutate the list when validation fails", async () => {
    const { executor, current } = tool();
    const result = await executor.execute({
      toolCallId: "call-1",
      toolName: "todo",
      arguments: {
        items: [
          { id: "t1", content: "a", state: "in_progress" },
          { id: "t2", content: "b", state: "in_progress" },
        ],
      },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "multiple_in_progress",
      text: null,
    });
    assert.equal(current().items.length, 0);
    assert.equal(current().revision, 0);
  });

  it("rejects malformed arguments without touching the list", async () => {
    const { executor, current } = tool();
    for (const args of [null, {}, { items: "not-an-array" }]) {
      const result = await executor.execute({
        toolCallId: "call-1",
        toolName: "todo",
        arguments: args,
      });
      assert.equal(result.status, "failed");
    }
    assert.equal(current().revision, 0);
  });
});
