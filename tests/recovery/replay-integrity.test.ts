import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

async function completedEvents() {
  const ids = new SequenceIds("replay");
  const digests = new JsonDigest();
  const log = new InMemoryEventLog(ids, digests);
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_started",
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:00.000Z",
    payload: { kind: "run_started", input: "synthetic task" },
  });
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_completed",
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:01.000Z",
    payload: { kind: "run_completed", text: "done" },
  });
  return { events: await log.read("session-1"), digests };
}

describe("event replay integrity", () => {
  it("replays a valid event chain", async () => {
    const { events, digests } = await completedEvents();
    const result = await replayRun(events, digests);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.state, "completed");
    assert.equal(result.value.finalText, "done");
  });

  it("rejects a payload changed after it was hashed", async () => {
    const { events, digests } = await completedEvents();
    const first = events[0];
    assert.notEqual(first, undefined);
    if (first === undefined) return;
    const tampered = [
      {
        ...first,
        payload: { kind: "run_started" as const, input: "changed after hash" },
      },
      ...events.slice(1),
    ];
    assert.deepEqual(await replayRun(tampered, digests), { ok: false, code: "chain_invalid" });
  });

  it("rejects a missing sequence number", async () => {
    const { events, digests } = await completedEvents();
    const first = events[0];
    assert.notEqual(first, undefined);
    if (first === undefined) return;
    const tampered = [{ ...first, seq: 2 }, ...events.slice(1)];
    assert.deepEqual(await replayRun(tampered, digests), {
      ok: false,
      code: "sequence_invalid",
    });
  });

  it("rejects a chain that does not end in a reportable state", async () => {
    const { events, digests } = await completedEvents();
    assert.deepEqual(await replayRun(events.slice(0, 1), digests), {
      ok: false,
      code: "replay_invalid",
    });
  });

  it("retains a dispatch without a terminal tool outcome as uncertain", async () => {
    const ids = new SequenceIds("replay");
    const digests = new JsonDigest();
    const log = new InMemoryEventLog(ids, digests);
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "run_started",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:00.000Z",
      payload: { kind: "run_started", input: "synthetic task" },
    });
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "tool_dispatch_committed",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:01.000Z",
      payload: {
        kind: "tool_dispatch_committed",
        dispatchId: "dispatch-1",
        toolCallId: "call-1",
        approvalId: null,
      },
    });
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "run_failed",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:02.000Z",
      payload: { kind: "run_failed", safeCode: "recovery_required" },
    });

    const result = await replayRun(await log.read("session-1"), digests);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.uncertainDispatches, ["call-1"]);
  });

  it("rejects a completed Run with an unresolved dispatch", async () => {
    const ids = new SequenceIds("replay");
    const digests = new JsonDigest();
    const log = new InMemoryEventLog(ids, digests);
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "run_started",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:00.000Z",
      payload: { kind: "run_started", input: "synthetic task" },
    });
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "tool_dispatch_committed",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:01.000Z",
      payload: {
        kind: "tool_dispatch_committed",
        dispatchId: "dispatch-1",
        toolCallId: "call-1",
        approvalId: null,
      },
    });
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "run_completed",
      correlationId: "correlation-1",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:02.000Z",
      payload: { kind: "run_completed", text: "must not be clean" },
    });

    assert.deepEqual(await replayRun(await log.read("session-1"), digests), {
      ok: false,
      code: "replay_invalid",
    });
  });
});
