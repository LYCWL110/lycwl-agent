import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeTodoList,
  emptyTodoList,
  replaceTodoList,
  TODO_LIMITS,
  todoCounts,
} from "../../src/domain/planning/todo.ts";

function replace(input: unknown) {
  return replaceTodoList(emptyTodoList(), input);
}

describe("todo list replacement", () => {
  it("accepts a bounded list and bumps the revision", () => {
    const first = replace([
      { id: "t1", content: "Inspect code", state: "completed" },
      { id: "t2", content: "Apply fix", state: "in_progress" },
      { id: "t3", content: "Run tests", state: "pending" },
    ]);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.revision, 1);
    assert.deepEqual(
      first.value.items.map((item) => item.state),
      ["completed", "in_progress", "pending"],
    );

    const second = replaceTodoList(first.value, [
      { id: "t1", content: "Inspect code", state: "completed" },
      { id: "t2", content: "Apply fix", state: "completed" },
      { id: "t3", content: "Run tests", state: "in_progress" },
    ]);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.revision, 2);
  });

  it("retains completed and cancelled items instead of dropping them", () => {
    const result = replace([
      { id: "t1", content: "done thing", state: "completed" },
      { id: "t2", content: "dropped thing", state: "cancelled" },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(todoCounts(result.value), {
      pending: 0,
      in_progress: 0,
      completed: 1,
      cancelled: 1,
    });
  });

  it("clears only on an explicit empty list", () => {
    const populated = replace([{ id: "t1", content: "x", state: "pending" }]);
    assert.equal(populated.ok, true);
    if (!populated.ok) return;
    const cleared = replaceTodoList(populated.value, []);
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(cleared.value.items.length, 0);
    assert.equal(cleared.value.revision, 2);
  });

  it("rejects more than 100 items", () => {
    const items = Array.from({ length: TODO_LIMITS.maxItems + 1 }, (_, index) => ({
      id: `t${index}`,
      content: "x",
      state: "pending",
    }));
    assert.deepEqual(replace(items), { ok: false, code: "too_many_items" });
  });

  it("rejects over-long content instead of truncating", () => {
    assert.deepEqual(
      replace([
        {
          id: "t1",
          content: "x".repeat(TODO_LIMITS.maxContentCodePoints + 1),
          state: "pending",
        },
      ]),
      { ok: false, code: "content_too_long" },
    );
  });

  it("rejects duplicate, empty ids and empty content", () => {
    assert.deepEqual(
      replace([
        { id: "t1", content: "a", state: "pending" },
        { id: "t1", content: "b", state: "pending" },
      ]),
      { ok: false, code: "duplicate_id" },
    );
    assert.deepEqual(replace([{ id: "", content: "a", state: "pending" }]), {
      ok: false,
      code: "empty_id",
    });
    assert.deepEqual(replace([{ id: "t1", content: "   ", state: "pending" }]), {
      ok: false,
      code: "empty_content",
    });
  });

  it("rejects an unknown state and more than one in_progress", () => {
    assert.deepEqual(replace([{ id: "t1", content: "a", state: "blocked" }]), {
      ok: false,
      code: "invalid_state",
    });
    assert.deepEqual(
      replace([
        { id: "t1", content: "a", state: "in_progress" },
        { id: "t2", content: "b", state: "in_progress" },
      ]),
      { ok: false, code: "multiple_in_progress" },
    );
  });

  it("allows no in_progress item at all", () => {
    const result = replace([{ id: "t1", content: "a", state: "pending" }]);
    assert.equal(result.ok, true);
  });

  it("rejects a non-array or malformed entry", () => {
    assert.deepEqual(replace(null), { ok: false, code: "invalid_list" });
    assert.deepEqual(replace({ items: [] }), { ok: false, code: "invalid_list" });
    assert.deepEqual(replace([null]), { ok: false, code: "invalid_list" });
    assert.deepEqual(replace([{ id: "t1" }]), { ok: false, code: "invalid_list" });
  });

  it("describes the list with per-state counts", () => {
    const result = replace([
      { id: "t1", content: "one", state: "completed" },
      { id: "t2", content: "two", state: "in_progress" },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const text = describeTodoList(result.value);
    assert.match(text, /todo: 2 item\(s\) revision=1/);
    assert.match(text, /pending=0 in_progress=1 completed=1 cancelled=0/);
    assert.match(text, /\[in_progress\] t2: two/);
  });
});
