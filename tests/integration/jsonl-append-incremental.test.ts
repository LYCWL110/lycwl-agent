import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";

/**
 * Incremental append.
 *
 * The log caches a verified prefix so an append does not re-read and re-hash every
 * earlier event. The cache is the risky part: if it were trusted blindly, an
 * external edit would be accepted silently. These tests cover both the speed
 * property and every way the cache can be invalidated.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

const BUDGET = {
  modelRounds: 0,
  compactions: 0,
  elapsedActiveMs: 0,
  testFixCycles: 0,
  knownSpendingUsd: 0,
};

function budgetInput(sessionId: string, elapsed: number) {
  return {
    sessionId,
    runId: "run-1",
    correlationId: "corr-1",
    causationId: null,
    timestampUtc: new Date().toISOString(),
    type: "run_budget_updated" as const,
    payload: {
      kind: "run_budget_updated" as const,
      budget: { ...BUDGET, elapsedActiveMs: elapsed },
      costUnknown: false,
    },
  };
}

async function freshLog(): Promise<{ log: JsonlEventLog; root: string; sessionId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "jsonl-append-"));
  return { log: new JsonlEventLog(root, ids, digests), root, sessionId: "ws-append" };
}

const eventPath = (root: string, sessionId: string) =>
  path.join(root, "sessions", sessionId, "events.jsonl");

describe("incremental append", () => {
  it("produces the same chain as a full replay", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      for (let index = 0; index < 20; index += 1) await log.append(budgetInput(sessionId, index));
      const events = await log.read(sessionId);
      assert.equal(events.length, 20);
      // seq is contiguous and every hash covers the recorded body.
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_unused, index) => index + 1),
      );
      for (const event of events) {
        const { hash, ...body } = event;
        assert.equal(await digests.sha256Canonical(body), hash);
      }
      // The links point backwards correctly.
      for (let index = 1; index < events.length; index += 1) {
        assert.equal(events[index]?.previousEventId, events[index - 1]?.eventId);
        assert.equal(events[index]?.previousHash, events[index - 1]?.hash);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not grow in cost with the number of events", async () => {
    // The whole point of the change: appending the 300th event must not cost
    // materially more than appending the 10th. Before, each append re-read and
    // re-hashed the entire log.
    const { log, root, sessionId } = await freshLog();
    try {
      const early: number[] = [];
      const late: number[] = [];
      for (let index = 0; index < 300; index += 1) {
        const started = performance.now();
        await log.append(budgetInput(sessionId, index));
        const elapsed = performance.now() - started;
        if (index < 50) early.push(elapsed);
        if (index >= 250) late.push(elapsed);
      }
      const average = (values: readonly number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      // A generous bound: the failure mode was quadratic, which is orders of
      // magnitude, not a factor of two.
      assert.ok(
        average(late) < average(early) * 5 + 5,
        `late appends must not grow with log size (early ${average(early).toFixed(2)}ms, late ${average(late).toFixed(2)}ms)`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-verifies when the file is longer than the cache knows", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      await log.append(budgetInput(sessionId, 0));
      await log.append(budgetInput(sessionId, 1));

      // Another writer appends behind this instance's back. The size no longer
      // matches, so the cache must be discarded and the file re-verified.
      const other = new JsonlEventLog(root, ids, digests);
      await other.append(budgetInput(sessionId, 2));

      const appended = await log.append(budgetInput(sessionId, 3));
      assert.equal(appended.seq, 4);
      const events = await log.read(sessionId);
      assert.equal(events.length, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a corrupted tail even when the size is unchanged", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      await log.append(budgetInput(sessionId, 0));
      await log.append(budgetInput(sessionId, 1));

      // Rewrite the last event's payload in place, keeping the byte length equal by
      // replacing a digit. The cached size still matches, so only a tail check can
      // catch this; the re-verification must reject it.
      const file = eventPath(root, sessionId);
      const text = await readFile(file, "utf8");
      const tampered = text.replace('"elapsedActiveMs":1', '"elapsedActiveMs":9');
      assert.notEqual(tampered, text, "the fixture must actually change a byte");
      await writeFile(file, tampered, "utf8");

      await assert.rejects(() => log.append(budgetInput(sessionId, 2)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a corrupted tail after a truncation", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      await log.append(budgetInput(sessionId, 0));
      await log.append(budgetInput(sessionId, 1));
      // Drop the trailing newline, which makes the last line an incomplete record.
      const file = eventPath(root, sessionId);
      const text = await readFile(file, "utf8");
      await writeFile(file, text.trimEnd(), "utf8");
      await assert.rejects(() => log.append(budgetInput(sessionId, 2)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an event that contradicts the earlier log", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      await log.append(budgetInput(sessionId, 0));
      // A task observation with no dispatched background_start call must be refused,
      // whether or not the prefix came from the cache.
      await assert.rejects(() =>
        log.append({
          sessionId,
          runId: "run-1",
          correlationId: "corr-1",
          causationId: null,
          timestampUtc: new Date().toISOString(),
          type: "background_task_observed",
          payload: {
            kind: "background_task_observed",
            task: {
              taskId: "t1",
              processExecutionId: "p1",
              launchingToolCallId: "missing",
              ownerRunId: "run-1",
              sessionId,
              state: "registered",
              observedAtUtc: new Date().toISOString(),
            },
          } as never,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps separate sessions independent", async () => {
    const { log, root } = await freshLog();
    try {
      await log.append(budgetInput("ws-a", 0));
      await log.append(budgetInput("ws-b", 0));
      const a = await log.append(budgetInput("ws-a", 1));
      const b = await log.append(budgetInput("ws-b", 1));
      assert.equal(a.seq, 2);
      assert.equal(b.seq, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still validates a freshly read log", async () => {
    const { log, root, sessionId } = await freshLog();
    try {
      for (let index = 0; index < 5; index += 1) await log.append(budgetInput(sessionId, index));
      // Append a syntactically valid line that breaks the hash chain, as an external
      // writer with a different id factory would.
      const forged = JSON.stringify({
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId,
        runId: "run-1",
        seq: 6,
        timestampUtc: new Date().toISOString(),
        type: "run_completed",
        correlationId: "corr-1",
        causationId: null,
        previousEventId: "not-the-previous",
        previousHash: "not-the-previous",
        payload: { kind: "run_completed" },
        hash: "0".repeat(64),
      });
      await appendFile(eventPath(root, sessionId), `${forged}\n`, "utf8");
      const read = await log.readWithRecovery(sessionId);
      assert.equal(read.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
