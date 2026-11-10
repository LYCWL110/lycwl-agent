import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKGROUND_LIMITS,
  type BackgroundTask,
  canStopTask,
  describeTask,
  initialCursor,
  type OutputRecord,
  readBackgroundPage,
  validateBackgroundLabel,
  validateBackgroundTimeout,
} from "../../src/domain/process/background.ts";

function record(index: number, stream: "stdout" | "stderr", text: string, start = 0): OutputRecord {
  return {
    recordIndex: index,
    stream,
    streamByteStart: start,
    byteLength: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: "task-1",
    processExecutionId: "exec-1",
    label: "build",
    state: "running",
    exitCode: null,
    records: [],
    captureComplete: true,
    timedOut: false,
    ...overrides,
  };
}

describe("background label and timeout", () => {
  it("accepts an omitted label and a bounded one", () => {
    assert.deepEqual(validateBackgroundLabel(undefined), { ok: true, value: null });
    assert.deepEqual(validateBackgroundLabel("build"), { ok: true, value: "build" });
  });

  it("rejects an empty or over-long label", () => {
    assert.deepEqual(validateBackgroundLabel("   "), { ok: false, code: "invalid_label" });
    assert.deepEqual(
      validateBackgroundLabel("x".repeat(BACKGROUND_LIMITS.maxLabelCodePoints + 1)),
      { ok: false, code: "invalid_label" },
    );
  });

  it("defaults the timeout to 600 seconds and caps at 1800 seconds", () => {
    assert.deepEqual(validateBackgroundTimeout(undefined), {
      ok: true,
      value: BACKGROUND_LIMITS.defaultTimeoutMs,
    });
    assert.deepEqual(validateBackgroundTimeout(1_800_000), { ok: true, value: 1_800_000 });
    for (const value of [0, 999, 1_800_001, 1.5]) {
      assert.deepEqual(validateBackgroundTimeout(value), {
        ok: false,
        code: "invalid_timeout",
      });
    }
  });
});

describe("background output paging", () => {
  it("starts at the first record and keeps stream provenance", () => {
    const t = task({
      records: [record(0, "stdout", "hello\n"), record(1, "stderr", "warn\n", 0)],
    });
    const page = readBackgroundPage(t, initialCursor(t), 1024);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.deepEqual(
      page.value.segments.map((segment) => `${segment.stream}:${segment.text}`),
      ["stdout:hello\n", "stderr:warn\n"],
    );
    assert.equal(page.value.caughtUp, true);
    assert.equal(page.value.taskEnded, false);
  });

  it("stops at the byte budget and resumes from the returned cursor", () => {
    const t = task({ records: [record(0, "stdout", "abcdefghij")] });
    const first = readBackgroundPage(t, initialCursor(t), 4);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.segments[0]?.text, "abcd");
    assert.equal(first.value.caughtUp, false);

    const second = readBackgroundPage(t, first.value.nextCursor, 100);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.segments[0]?.text, "efghij");
    assert.equal(second.value.caughtUp, true);
  });

  it("does not split a multi-byte character", () => {
    const t = task({ records: [record(0, "stdout", "日本語")] });
    const page = readBackgroundPage(t, initialCursor(t), 4);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    // Each character is 3 UTF-8 bytes, so only one fits in 4 bytes.
    assert.equal(page.value.segments[0]?.text, "日");
  });

  it("reports page_too_small rather than looping without progress", () => {
    const t = task({ records: [record(0, "stdout", "日")] });
    const page = readBackgroundPage(t, initialCursor(t), 2);
    assert.deepEqual(page, { ok: false, code: "page_too_small" });
  });

  it("rejects a cursor from another task or execution", () => {
    const t = task({ records: [record(0, "stdout", "x")] });
    assert.deepEqual(readBackgroundPage(t, { ...initialCursor(t), taskId: "other" }, 64), {
      ok: false,
      code: "cursor_task_mismatch",
    });
    assert.deepEqual(
      readBackgroundPage(t, { ...initialCursor(t), processExecutionId: "other" }, 64),
      { ok: false, code: "cursor_execution_mismatch" },
    );
  });

  it("rejects an ahead or malformed cursor", () => {
    const t = task({ records: [record(0, "stdout", "x")] });
    assert.deepEqual(readBackgroundPage(t, { ...initialCursor(t), recordIndex: 5 }, 64), {
      ok: false,
      code: "cursor_ahead",
    });
    assert.deepEqual(readBackgroundPage(t, { ...initialCursor(t), recordIndex: -1 }, 64), {
      ok: false,
      code: "invalid_cursor",
    });
  });

  it("separates taskEnded from captureComplete", () => {
    const t = task({
      state: "exited",
      exitCode: 0,
      captureComplete: false,
      records: [record(0, "stdout", "partial")],
    });
    const page = readBackgroundPage(t, initialCursor(t), 1024);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.taskEnded, true);
    assert.equal(page.value.captureComplete, false);
    assert.equal(page.value.truncated, true);
  });

  it("allows re-reading the same range after the task ends", () => {
    const t = task({ state: "exited", exitCode: 0, records: [record(0, "stdout", "abc")] });
    const cursor = initialCursor(t);
    const first = readBackgroundPage(t, cursor, 1024);
    const second = readBackgroundPage(t, cursor, 1024);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value.segments, second.value.segments);
  });
});

describe("background stop preconditions", () => {
  it("allows stopping only a running task", () => {
    assert.deepEqual(canStopTask(task({ state: "running" })), { ok: true, value: true });
    for (const state of ["exited", "stopped", "unknown"] as const) {
      assert.deepEqual(canStopTask(task({ state })), {
        ok: false,
        code: "task_not_terminal",
      });
    }
  });
});

describe("background description", () => {
  it("reports state, records and capture completeness", () => {
    const text = describeTask(
      task({ state: "exited", exitCode: 0, records: [record(0, "stdout", "x")] }),
    );
    assert.match(text, /taskId=task-1/);
    assert.match(text, /state=exited/);
    assert.match(text, /exitCode=0/);
    assert.match(text, /records=1/);
    assert.match(text, /captureComplete=true/);
  });
});
