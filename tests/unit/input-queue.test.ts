import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consumeRunInput,
  emptyRunInputQueue,
  type QueueInputCommand,
  queueRunInput,
  RUN_INPUT_LIMITS,
  type RunInputQueue,
  withdrawRunInput,
} from "../../src/domain/run/input-queue.ts";

function command(overrides: Partial<QueueInputCommand> = {}): QueueInputCommand {
  return {
    commandId: "command-1",
    inputId: "input-1",
    text: "additional requirement",
    acceptedSeq: 1,
    runState: "active",
    ...overrides,
  };
}

function queued(...commands: readonly QueueInputCommand[]): RunInputQueue {
  let queue = emptyRunInputQueue();
  for (const item of commands) {
    const result = queueRunInput(queue, item);
    if (!result.ok) throw new Error(result.code);
    queue = result.queue;
  }
  return queue;
}

describe("ordinary run input queue", () => {
  it("queues input in acceptance order", () => {
    const queue = queued(
      command({ commandId: "c1", inputId: "i1", acceptedSeq: 1 }),
      command({ commandId: "c2", inputId: "i2", acceptedSeq: 2 }),
    );
    assert.deepEqual(
      queue.items.map((item) => item.inputId),
      ["i1", "i2"],
    );
  });

  it("deduplicates a replayed command id without queueing twice", () => {
    const queue = queued(command());
    const replay = queueRunInput(queue, command());
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.duplicate, true);
    assert.equal(replay.queue.items.length, 1);
  });

  it("rejects a reused command id with a different input", () => {
    const queue = queued(command());
    assert.deepEqual(queueRunInput(queue, command({ inputId: "input-2" })), {
      ok: false,
      code: "invalid_identity",
    });
  });

  it("rejects input on a terminal Run", () => {
    for (const runState of ["completed", "failed", "cancelled"] as const) {
      assert.deepEqual(queueRunInput(emptyRunInputQueue(), command({ runState })), {
        ok: false,
        code: "run_terminal",
      });
    }
  });

  it("rejects blank text", () => {
    assert.deepEqual(queueRunInput(emptyRunInputQueue(), command({ text: "   " })), {
      ok: false,
      code: "invalid_text",
    });
  });

  it("enforces the per-item and pending-unit limits without truncating", () => {
    const tooLong = "x".repeat(RUN_INPUT_LIMITS.maxItemUtf16Units + 1);
    assert.deepEqual(queueRunInput(emptyRunInputQueue(), command({ text: tooLong })), {
      ok: false,
      code: "input_too_long",
    });

    const half = "x".repeat(RUN_INPUT_LIMITS.maxItemUtf16Units);
    const full = queued(
      ...Array.from({ length: 8 }, (_, index) =>
        command({
          commandId: `c${index}`,
          inputId: `i${index}`,
          acceptedSeq: index + 1,
          text: half,
        }),
      ),
    );
    assert.deepEqual(
      queueRunInput(full, command({ commandId: "c9", inputId: "i9", acceptedSeq: 9, text: "x" })),
      { ok: false, code: "queue_units_exceeded" },
    );
  });

  it("enforces the pending item count", () => {
    const items = Array.from({ length: RUN_INPUT_LIMITS.maxPendingItems }, (_, index) =>
      command({ commandId: `c${index}`, inputId: `i${index}`, acceptedSeq: index + 1, text: "x" }),
    );
    const full = queued(...items);
    assert.deepEqual(
      queueRunInput(full, command({ commandId: "extra", inputId: "extra", acceptedSeq: 99 })),
      { ok: false, code: "queue_full" },
    );
  });

  it("rejects a non-increasing acceptance sequence", () => {
    const queue = queued(command({ acceptedSeq: 5 }));
    assert.deepEqual(
      queueRunInput(queue, command({ commandId: "c2", inputId: "i2", acceptedSeq: 5 })),
      { ok: false, code: "sequence_not_increasing" },
    );
  });

  it("consumes only inputs at or below the high-water mark", () => {
    const queue = queued(
      command({ commandId: "c1", inputId: "i1", acceptedSeq: 1 }),
      command({ commandId: "c2", inputId: "i2", acceptedSeq: 3 }),
    );
    const consumed = consumeRunInput(queue, 1, 2);
    assert.equal(consumed.ok, true);
    if (!consumed.ok) return;
    assert.deepEqual(consumed.batch, {
      inputIds: ["i1"],
      throughSeq: 1,
      taskRevision: 2,
    });
    assert.deepEqual(
      consumed.queue.items.map((item) => item.inputId),
      ["i2"],
    );
  });

  it("refuses an empty or invalid consume boundary", () => {
    assert.deepEqual(consumeRunInput(emptyRunInputQueue(), 1, 1), {
      ok: false,
      code: "empty_batch",
    });
    assert.deepEqual(consumeRunInput(emptyRunInputQueue(), -1, 1), {
      ok: false,
      code: "invalid_high_water",
    });
  });

  it("withdraws only an unconsumed input", () => {
    const queue = queued(command({ commandId: "c1", inputId: "i1" }));
    const withdrawn = withdrawRunInput(queue, "i1");
    assert.equal(withdrawn.ok, true);
    if (!withdrawn.ok) return;
    assert.equal(withdrawn.queue.items.length, 0);
    assert.deepEqual(withdrawRunInput(withdrawn.queue, "i1"), {
      ok: false,
      code: "unknown_input",
    });
  });

  it("does not let a withdrawn input reappear after consumption", () => {
    const queue = queued(command({ commandId: "c1", inputId: "i1", acceptedSeq: 1 }));
    const consumed = consumeRunInput(queue, 1, 1);
    assert.equal(consumed.ok, true);
    if (!consumed.ok) return;
    assert.deepEqual(withdrawRunInput(consumed.queue, "i1"), {
      ok: false,
      code: "unknown_input",
    });
  });
});
