import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import {
  type CheckpointWriter,
  RuntimeCoordinator,
} from "../../src/application/coordinator/runtime-coordinator.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const RESPONSES = [{ kind: "completed" as const, toolCalls: [], text: "done" }];

function build(checkpoints?: CheckpointWriter) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(RESPONSES),
    tools: new RecordingTools(false, { status: "succeeded", text: null }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
    ...(checkpoints === undefined ? {} : { checkpoints }),
  });
  return { digests, eventLog, coordinator };
}

class RecordingWriter implements CheckpointWriter {
  readonly noted: string[] = [];
  readonly writes: { sessionId: string; eventCount: number }[] = [];

  noteEvent(sessionId: string, event: InternalEvent): boolean {
    this.noted.push(`${sessionId}:${event.type}`);
    return event.type === "run_completed";
  }

  async write(sessionId: string, events: readonly InternalEvent[]): Promise<unknown> {
    this.writes.push({ sessionId, eventCount: events.length });
    return null;
  }
}

describe("checkpoint integration", () => {
  it("writes a checkpoint on a terminal event", async () => {
    const writer = new RecordingWriter();
    const { coordinator } = build(writer);

    const result = await coordinator.run("checkpoint task");

    assert.equal(result.status, "completed");
    assert.equal(writer.writes.length, 1);
    assert.equal(writer.writes[0]?.eventCount, result.events.length);
    assert.equal(writer.noted.at(-1)?.endsWith(":run_completed"), true);
  });

  it("does not write a checkpoint when nothing is due", async () => {
    const writer = new RecordingWriter();
    writer.noteEvent = () => false;
    const { coordinator } = build(writer);

    await coordinator.run("no checkpoint task");

    assert.equal(writer.writes.length, 0);
  });

  it("keeps the Run successful when the checkpoint write fails", async () => {
    const writer: CheckpointWriter = {
      noteEvent: () => true,
      write: async () => {
        throw new Error("disk full");
      },
    };
    const { coordinator, eventLog } = build(writer);

    const result = await coordinator.run("checkpoint failure task");

    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
    const stored = await eventLog.read(result.events[0]?.sessionId ?? "");
    assert.equal(stored.length, result.events.length);
  });

  it("keeps the Run successful when the checkpoint counter fails", async () => {
    const writer: CheckpointWriter = {
      noteEvent: () => {
        throw new Error("counter broken");
      },
      write: async () => {
        throw new Error("must not be called");
      },
    };
    const { coordinator } = build(writer);

    const result = await coordinator.run("counter failure task");

    assert.equal(result.status, "completed");
  });

  it("produces a checkpoint that validates against the real store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-cp-int-"));
    const digests = new JsonDigest();
    const store = new JsonlCheckpointStore(root, digests);
    const { coordinator, eventLog } = build({
      noteEvent: (sessionId, event) => store.noteEvent(sessionId, event),
      write: (sessionId, events) => store.write(sessionId, events),
    });

    const result = await coordinator.run("real store task");
    assert.equal(result.status, "completed");

    const sessionId = result.events[0]?.sessionId ?? "";
    const events = await eventLog.read(sessionId);
    const read = await store.read(sessionId, events);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.runState, "completed");

    const replayed = await replayRun(events, digests);
    assert.equal(replayed.ok, true);
  });
});
