import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

async function buildEvents(count: number): Promise<readonly InternalEvent[]> {
  const log = new InMemoryEventLog(new SequenceIds("cp"), new JsonDigest());
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_started",
    correlationId: "c",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:00.000Z",
    payload: { kind: "run_started", input: "task" },
  });
  for (let index = 1; index < count; index += 1) {
    await log.append({
      sessionId: "session-1",
      runId: "run-1",
      type: "model_request_started",
      correlationId: "c",
      causationId: null,
      timestampUtc: "2026-11-02T00:00:01.000Z",
      payload: { kind: "model_request_started", modelRequestId: "request-1", attemptNo: index },
    });
  }
  await log.append({
    sessionId: "session-1",
    runId: "run-1",
    type: "run_completed",
    correlationId: "c",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:02.000Z",
    payload: { kind: "run_completed", text: "done" },
  });
  return log.read("session-1");
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "lycwl-checkpoint-"));
}

describe("checkpoint storage", () => {
  it("writes, reads back and resets the pacing counter", async () => {
    const root = await tempRoot();
    const digests = new JsonDigest();
    const store = new JsonlCheckpointStore(root, digests);
    const events = await buildEvents(3);

    const written = await store.write("session-1", events);
    assert.notEqual(written, null);

    const read = await store.read("session-1", events);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.throughSeq, events.at(-1)?.seq);
    assert.equal(read.value.runState, "completed");
  });

  it("reports missing, corrupted and hash-mismatched documents", async () => {
    const root = await tempRoot();
    const digests = new JsonDigest();
    const store = new JsonlCheckpointStore(root, digests);
    const events = await buildEvents(2);

    assert.deepEqual(await store.read("session-1", events), { ok: false, code: "missing" });

    await store.write("session-1", events);
    const filePath = path.join(root, "sessions", "session-1", "checkpoint.json");

    await writeFile(filePath, "not json", "utf8");
    assert.deepEqual(await store.read("session-1", events), {
      ok: false,
      code: "invalid_document",
    });

    await store.write("session-1", events);
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      checkpoint: { runState: string };
    };
    raw.checkpoint.runState = "failed";
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    assert.deepEqual(await store.read("session-1", events), {
      ok: false,
      code: "hash_mismatch",
    });
  });

  it("discards a stale checkpoint without touching the event log", async () => {
    const root = await tempRoot();
    const store = new JsonlCheckpointStore(root, new JsonDigest());
    const events = await buildEvents(3);
    await store.write("session-1", events);

    const truncated = events.slice(0, 1);
    assert.deepEqual(await store.read("session-1", truncated), {
      ok: false,
      code: "newer_than_log",
    });

    await store.discard("session-1");
    assert.deepEqual(await store.read("session-1", events), { ok: false, code: "missing" });
    await store.discard("session-1");
  });

  it("leaves no temporary file behind after a successful write", async () => {
    const root = await tempRoot();
    const store = new JsonlCheckpointStore(root, new JsonDigest());
    const events = await buildEvents(2);
    await store.write("session-1", events);

    const filePath = path.join(root, "sessions", "session-1", "checkpoint.json");
    const tempPath = `${filePath}.tmp`;
    await assert.rejects(readFile(tempPath));
    const content = await readFile(filePath, "utf8");
    assert.match(content, /"throughSeq"/);
  });

  it("paces checkpoints by counting appended events", async () => {
    const root = await tempRoot();
    const store = new JsonlCheckpointStore(root, new JsonDigest());
    const events = await buildEvents(60);

    let due = false;
    for (const event of events) {
      due = store.noteEvent("session-1", event);
      if (due) break;
    }
    assert.equal(due, true);

    const written = await store.write("session-1", events);
    assert.notEqual(written, null);
    assert.equal(store.noteEvent("session-1", events[0] as InternalEvent), false);
  });
});
