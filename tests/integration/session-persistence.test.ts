import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ModelProvider, ProviderCompletion } from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";

/**
 * Durable Session history.
 *
 * ADR-0054 records that the entry point used an in-memory event log, so every
 * launch began with no history. These tests drive the real JSONL log through the
 * coordinator and prove that a second coordinator over the same directory sees the
 * first one's events.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-persist-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

const noTools: ToolExecutor = {
  getDefinition: (): ToolDefinition | null => null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

class EchoProvider implements ModelProvider {
  async complete(): Promise<ProviderCompletion> {
    return { kind: "completed", toolCalls: [], text: "ok" };
  }
}

function coordinator(directory: string, sessionId: string) {
  return new RuntimeCoordinator({
    provider: new EchoProvider(),
    tools: noTools,
    approvals: { decide: async () => "approved" },
    eventLog: new JsonlEventLog(directory, ids, digests),
    checkpoints: new JsonlCheckpointStore(directory, digests),
    ids,
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: false,
    sessionId,
  });
}

describe("durable session history", () => {
  it("writes events to disk under the fixed session id", async () => {
    const directory = path.join(root, "writes");
    const sessionId = "ws-test-writes";

    const result = await coordinator(directory, sessionId).run("first task");
    assert.equal(result.status, "completed");

    const log = new JsonlEventLog(directory, ids, digests);
    const events = await log.read(sessionId);
    assert.ok(events.length > 0, "events must be readable from disk");
    assert.equal(
      events.find((event) => event.payload.kind !== "run_budget_updated")?.payload.kind,
      "run_started",
    );
    assert.equal(
      events.some((event) => event.payload.kind === "run_completed"),
      true,
    );
  });

  it("continues the same log from a second coordinator", async () => {
    const directory = path.join(root, "continue");
    const sessionId = "ws-test-continue";

    await coordinator(directory, sessionId).run("first");
    const firstCount = (await new JsonlEventLog(directory, ids, digests).read(sessionId)).length;

    await coordinator(directory, sessionId).run("second");
    const all = await new JsonlEventLog(directory, ids, digests).read(sessionId);

    assert.ok(all.length > firstCount, "the second Run must append, not replace");
    // Sequence numbers continue rather than restarting at 1.
    const seqs = all.map((event) => event.seq);
    assert.deepEqual(
      seqs,
      seqs.map((_unused, index) => index + 1),
    );
    const starts = all.filter((event) => event.payload.kind === "run_started");
    assert.equal(starts.length, 2, "both Runs are recorded");
  });

  it("keeps distinct sessions separate", async () => {
    const directory = path.join(root, "separate");
    await coordinator(directory, "ws-a").run("task a");
    await coordinator(directory, "ws-b").run("task b");

    const log = new JsonlEventLog(directory, ids, digests);
    const a = await log.read("ws-a");
    const b = await log.read("ws-b");
    assert.equal(a.length > 0, true);
    assert.equal(b.length > 0, true);
    assert.equal(
      a.some((event) => event.payload.kind === "run_started" && event.payload.input === "task b"),
      false,
    );
  });

  it("reports an empty log for a session that never ran", async () => {
    const directory = path.join(root, "empty");
    const log = new JsonlEventLog(directory, ids, digests);
    const result = await log.readWithRecovery("ws-never");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.events, []);
  });

  it("survives a corrupt tail without losing earlier events", async () => {
    const directory = path.join(root, "corrupt");
    const sessionId = "ws-corrupt";
    await coordinator(directory, sessionId).run("good run");

    const log = new JsonlEventLog(directory, ids, digests);
    const before = await log.read(sessionId);
    assert.ok(before.length > 0);

    // Append a partial line, as an interrupted write would.
    const { appendFile, readFile } = await import("node:fs/promises");
    // The log nests sessions under a "sessions" directory.
    const filePath = path.join(directory, "sessions", sessionId, "events.jsonl");
    await appendFile(filePath, '{"partial":', "utf8");

    const after = await new JsonlEventLog(directory, ids, digests).readWithRecovery(sessionId);
    // A trailing partial line is reported as invalid_event, not silently ignored:
    // the log cannot tell a crash-truncated write from real corruption, and
    // guessing would let a damaged history look healthy.
    assert.equal(after.ok, false);
    if (after.ok) return;
    assert.equal(after.code, "invalid_event");

    // The earlier events are still on disk and readable by a fresh reader that
    // stops at the last complete line.
    const raw = await readFile(filePath, "utf8");
    const completeLines = raw.split("\n").filter((line) => line.trim().length > 0).length;
    assert.equal(completeLines, before.length + 1, "the partial line is the extra one");
  });
});
