import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import {
  CHECKPOINT_INTERVAL_EVENTS,
  createCheckpoint,
  eventsAfterCheckpoint,
  shouldCheckpoint,
  validateCheckpoint,
} from "../../src/domain/persistence/checkpoint.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

async function build(
  append: (log: InMemoryEventLog) => Promise<void>,
): Promise<readonly InternalEvent[]> {
  const log = new InMemoryEventLog(new SequenceIds("cp"), new JsonDigest());
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_started",
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:00.000Z",
    payload: { kind: "run_started", input: "task" },
  });
  await append(log);
  return log.read("session-1");
}

function record(
  type: InternalEvent["type"],
  payload: InternalEvent["payload"],
): Parameters<InMemoryEventLog["append"]>[0] {
  return {
    sessionId: "session-1",
    runId: "run-1",
    type,
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:01.000Z",
    payload,
  };
}

describe("checkpoint pacing", () => {
  it("checkpoints every 50 events", () => {
    assert.equal(shouldCheckpoint(49, "model_request_started"), false);
    assert.equal(shouldCheckpoint(CHECKPOINT_INTERVAL_EVENTS, "model_request_started"), true);
    assert.equal(shouldCheckpoint(51, "model_request_started"), true);
  });

  it("always checkpoints on an important terminal change", () => {
    for (const type of ["run_completed", "run_failed", "run_cancelled", "run_waiting"] as const) {
      assert.equal(shouldCheckpoint(1, type), true);
    }
  });
});

describe("checkpoint construction", () => {
  it("records the last covered event and derived facts", async () => {
    const events = await build(async (log) => {
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-1",
          approvalId: null,
        }),
      );
      await log.append(
        record("tool_execution_finished", {
          kind: "tool_execution_finished",
          toolCallId: "call-1",
          status: "succeeded",
          safeCode: null,
          text: "ok",
        }),
      );
      await log.append(record("run_completed", { kind: "run_completed", text: "done" }));
    });

    const checkpoint = createCheckpoint("session-1", events, 3);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;
    const last = events.at(-1);
    assert.equal(checkpoint.throughSeq, last?.seq);
    assert.equal(checkpoint.throughEventId, last?.eventId);
    assert.equal(checkpoint.throughHash, last?.hash);
    assert.equal(checkpoint.runState, "completed");
    assert.equal(checkpoint.safeFailureCode, null);
    assert.deepEqual(checkpoint.toolOutcomes, { "call-1": "succeeded" });
    assert.deepEqual(checkpoint.uncertainDispatches, []);
    assert.equal(checkpoint.modelAttempts, 0);
  });

  it("retains an unresolved dispatch as uncertain", async () => {
    const events = await build(async (log) => {
      await log.append(
        record("tool_dispatch_committed", {
          kind: "tool_dispatch_committed",
          dispatchId: "dispatch-1",
          toolCallId: "call-1",
          approvalId: null,
        }),
      );
      await log.append(record("run_failed", { kind: "run_failed", safeCode: "recovery_required" }));
    });

    const checkpoint = createCheckpoint("session-1", events, 2);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;
    assert.deepEqual(checkpoint.uncertainDispatches, ["call-1"]);
    assert.equal(checkpoint.runState, "failed");
    assert.equal(checkpoint.safeFailureCode, "recovery_required");
  });

  it("returns null for an empty event list", () => {
    assert.equal(createCheckpoint("session-1", [], 0), null);
  });
});

describe("checkpoint validation", () => {
  it("accepts a checkpoint that describes a log prefix", async () => {
    const events = await build(async (log) => {
      await log.append(record("run_completed", { kind: "run_completed", text: "done" }));
    });
    const checkpoint = createCheckpoint("session-1", events, 2);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;

    const result = validateCheckpoint({ checkpoint, hash: "x" }, events);
    assert.equal(result.ok, true);
  });

  it("rejects a checkpoint that is newer than the log", async () => {
    const events = await build(async (log) => {
      await log.append(record("run_completed", { kind: "run_completed", text: "done" }));
    });
    const checkpoint = createCheckpoint("session-1", events, 2);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;

    assert.deepEqual(validateCheckpoint({ checkpoint }, events.slice(0, 1)), {
      ok: false,
      code: "newer_than_log",
    });
  });

  it("rejects a checkpoint whose covered event changed", async () => {
    const events = await build(async (log) => {
      await log.append(record("run_completed", { kind: "run_completed", text: "done" }));
    });
    const checkpoint = createCheckpoint("session-1", events, 2);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;

    const tampered = events.map((event, index) =>
      index === events.length - 1 ? { ...event, hash: "different" } : event,
    );
    assert.deepEqual(validateCheckpoint({ checkpoint }, tampered), {
      ok: false,
      code: "hash_mismatch",
    });
  });

  it("rejects malformed documents and unknown schema versions", () => {
    assert.deepEqual(validateCheckpoint(null, []), { ok: false, code: "invalid_document" });
    assert.deepEqual(validateCheckpoint({}, []), { ok: false, code: "invalid_document" });
    assert.deepEqual(validateCheckpoint({ checkpoint: { schemaVersion: 2 } }, []), {
      ok: false,
      code: "unknown_schema_version",
    });
    assert.deepEqual(validateCheckpoint({ checkpoint: { schemaVersion: 1 } }, []), {
      ok: false,
      code: "not_a_checkpoint",
    });
  });

  it("returns only the events after the checkpoint", async () => {
    const events = await build(async (log) => {
      await log.append(record("run_completed", { kind: "run_completed", text: "done" }));
    });
    const checkpoint = createCheckpoint("session-1", events.slice(0, 1), 1);
    assert.notEqual(checkpoint, null);
    if (checkpoint === null) return;

    const rest = eventsAfterCheckpoint(events, checkpoint);
    assert.equal(rest.length, 1);
    assert.equal(rest[0]?.seq, 2);
  });
});
