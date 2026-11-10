import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { deriveView } from "../../src/tui/view-model.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

function input(sessionId: string, text: string) {
  return {
    sessionId,
    runId: "run-1",
    type: "run_started" as const,
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:00.000Z",
    payload: { kind: "run_started" as const, input: text },
  };
}

describe("JSONL event persistence", () => {
  it("restores queued-input request linkage without treating interrupted sends as confirmed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-queue-"));
    try {
      const ids = new SequenceIds("persist");
      const digests = new JsonDigest();
      const log = new JsonlEventLog(root, ids, digests);
      await log.append(input("session-1", "first"));
      await log.append({
        ...input("session-1", ""),
        type: "run_input_queued",
        payload: { kind: "run_input_queued", inputId: "i", text: "second", acceptedSeq: 1 },
      });
      await log.append({
        ...input("session-1", ""),
        type: "run_input_batch_consumed",
        payload: {
          kind: "run_input_batch_consumed",
          inputIds: ["i"],
          throughSeq: 1,
          taskRevision: 1,
        },
      });
      await log.append({
        ...input("session-1", ""),
        type: "model_request_started",
        payload: {
          kind: "model_request_started",
          modelRequestId: "m",
          attemptNo: 1,
          includedInputIds: ["i"],
        },
      });
      await log.append({
        ...input("session-1", ""),
        type: "run_cancelled",
        payload: { kind: "run_cancelled", safeCode: "cancelled" },
      });
      const events = await new JsonlEventLog(root, ids, digests).read("session-1");
      assert.equal((await replayRun(events, digests)).ok, true);
      const view = deriveView({
        events,
        runStatus: "cancelled",
        safeCode: null,
        todo: null,
        pendingApproval: null,
        pendingQuestion: null,
        draft: "",
      });
      assert.equal(view.transcript.find((entry) => entry.text === "second")?.status, "unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("appends events and replays them after reopening the adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-"));
    try {
      const ids = new SequenceIds("persist");
      const digests = new JsonDigest();
      const log = new JsonlEventLog(root, ids, digests);
      await log.append(input("session-1", "first"));
      await log.append({
        ...input("session-1", "ignored"),
        type: "run_completed",
        payload: { kind: "run_completed", text: "done" },
      });

      const reopened = new JsonlEventLog(root, ids, digests);
      const events = await reopened.read("session-1");
      assert.equal(events.length, 2);
      const replayed = await replayRun(events, digests);
      assert.equal(replayed.ok, true);
      if (!replayed.ok) return;
      assert.equal(replayed.value.state, "completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a malformed middle line without treating it as a recoverable tail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-"));
    try {
      const log = new JsonlEventLog(root, new SequenceIds("persist"), new JsonDigest());
      await log.append(input("session-1", "first"));
      await log.append({
        ...input("session-1", "ignored"),
        type: "run_completed",
        payload: { kind: "run_completed", text: "done" },
      });
      const file = path.join(root, "sessions", "session-1", "events.jsonl");
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      lines.splice(1, 0, "{malformed}");
      await writeFile(file, lines.join("\n"), "utf8");
      assert.deepEqual(await log.readWithRecovery("session-1"), {
        ok: false,
        code: "middle_corruption",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a corrupt middle record when appending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-"));
    try {
      const log = new JsonlEventLog(root, new SequenceIds("persist"), new JsonDigest());
      await log.append(input("session-1", "first"));
      const file = path.join(root, "sessions", "session-1", "events.jsonl");
      const original = await readFile(file, "utf8");
      await writeFile(file, `{malformed}\n${original}`, "utf8");
      await assert.rejects(log.append(input("session-1", "second")));
      assert.equal(await readFile(file, "utf8"), `{malformed}\n${original}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an incomplete final line without claiming it is valid history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-"));
    try {
      const log = new JsonlEventLog(root, new SequenceIds("persist"), new JsonDigest());
      await log.append(input("session-1", "first"));
      const file = path.join(root, "sessions", "session-1", "events.jsonl");
      const original = await readFile(file, "utf8");
      await writeFile(file, `${original}{"incomplete":`, "utf8");
      assert.deepEqual(await log.readWithRecovery("session-1"), {
        ok: false,
        code: "invalid_event",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies hashes before restore and append without rewriting damaged originals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-hash-"));
    try {
      const log = new JsonlEventLog(root, new SequenceIds("hash"), new JsonDigest());
      await log.append(input("session-1", "original"));
      const file = path.join(root, "sessions", "session-1", "events.jsonl");
      const damaged = (await readFile(file, "utf8")).replace("original", "tampered");
      await writeFile(file, damaged);
      assert.deepEqual(await log.readWithRecovery("session-1"), {
        ok: false,
        code: "integrity_failure",
      });
      await assert.rejects(log.append(input("session-1", "next")), /integrity_failure/u);
      assert.equal(await readFile(file, "utf8"), damaged);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes independent writer objects, including all Runs in the Session hash chain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-writers-"));
    try {
      const digests = new JsonDigest();
      const a = new JsonlEventLog(root, new SequenceIds("a"), digests);
      const b = new JsonlEventLog(root, new SequenceIds("b"), digests);
      const written = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? a : b).append({
            ...input("session-1", String(index)),
            runId: `run-${index}`,
          }),
        ),
      );
      assert.equal(new Set(written.map((event) => event.seq)).size, 12);
      const restored = await b.read("session-1");
      assert.deepEqual(
        restored.map((event) => event.seq),
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported payloads, broken links, duplicate keys and malformed UTF-8", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-validation-"));
    try {
      const digests = new JsonDigest();
      const log = new JsonlEventLog(root, new SequenceIds("validation"), digests);
      const original = await log.append(input("session-1", "first"));
      const file = path.join(root, "sessions", "session-1", "events.jsonl");
      for (const patch of [
        { seq: 2 },
        { sessionId: "another" },
        { previousHash: "unlinked" },
        { schemaVersion: 2 },
        { payload: { kind: "run_started", input: 42 } },
        { type: "unknown_fact", payload: { kind: "unknown_fact" } },
      ]) {
        const { hash: _, ...body } = { ...original, ...patch };
        const event = { ...body, hash: await digests.sha256Canonical(body) };
        await writeFile(file, `${JSON.stringify(event)}\n`);
        assert.equal((await log.readWithRecovery("session-1")).ok, false, JSON.stringify(patch));
      }
      const valid = JSON.stringify(original);
      for (const invalid of [
        Buffer.from(`${valid.replace('"seq":1', '"seq":9,"seq":1')}\n`),
        Buffer.concat([Buffer.from(valid.replace("first", "")), Buffer.from([0xff, 0x0a])]),
        Buffer.from(valid),
      ]) {
        await writeFile(file, invalid);
        assert.equal((await log.readWithRecovery("session-1")).ok, false);
      }
      await assert.rejects(log.read("../escape"), /invalid_session_id/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds Session ownership across idle time, then allows an explicit handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-jsonl-owner-"));
    try {
      const log = new JsonlEventLog(root, new SequenceIds("owner"), new JsonDigest());
      const first = await log.acquireSessionOwnership("session-1");
      try {
        await assert.rejects(log.acquireSessionOwnership("session-1"), /lock_busy/u);
      } finally {
        first.release();
      }
      const next = await log.acquireSessionOwnership("session-1");
      next.release();
      next.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
