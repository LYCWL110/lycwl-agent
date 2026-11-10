import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rebuildConversation } from "../../src/application/coordinator/conversation-rebuild.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import type { InternalEvent, InternalEventPayload } from "../../src/ports/event-log.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * A compacted Run must rebuild as the summary it actually used.
 *
 * ADR-0056 records that `context_compacted` was ignored by the rebuild, so a resumed
 * Session replayed the original turns that the compaction had replaced — presenting
 * a history the model no longer holds.
 */

async function build(events: readonly InternalEventPayload[]): Promise<readonly InternalEvent[]> {
  const ids = new SequenceIds("ev");
  const log = new InMemoryEventLog(ids, new JsonDigest());
  for (const payload of events) {
    await log.append({
      sessionId: "s1",
      runId: "r1",
      type: payload.kind,
      correlationId: "c",
      causationId: null,
      timestampUtc: "2026-11-05T00:00:00.000Z",
      payload,
    });
  }
  return log.read("s1");
}

const SUMMARY =
  "[context-summary]\nnote=this replaces earlier turns\n- claim(unverified): did work";

describe("rebuild after compaction", () => {
  it("substitutes the summary for the turns it replaced", async () => {
    const events = await build([
      { kind: "run_started", input: "a very long first task" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "early answer",
      },
      {
        kind: "context_compacted",
        artifactSha256: "a".repeat(64),
        summarizedGroupIds: ["g1", "g2"],
        recentSuffixGroupIds: [],
        sourceHighWaterSeq: 2,
        estimatedAuxiliaryTokens: 100,
        artifactVersion: 1,
        summaryText: SUMMARY,
      },
      {
        kind: "model_response_validated",
        modelRequestId: "m2",
        attemptNo: 1,
        toolCallCount: 0,
        text: "after compaction",
      },
      { kind: "run_completed", text: "after compaction" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;

    const text = result.conversation
      .map((item) =>
        item.kind === "user" ? item.text : item.kind === "assistant" ? (item.text ?? "") : "",
      )
      .join("\n");

    // The summary is present.
    assert.match(text, /context-summary/);
    // The replaced original task is not replayed.
    assert.equal(
      text.includes("a very long first task"),
      false,
      "the summarised turn must not be replayed",
    );
  });

  it("keeps a later Run's history intact when an earlier one was compacted", async () => {
    const events = await build([
      { kind: "run_started", input: "run one task" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "one",
      },
      {
        kind: "context_compacted",
        artifactSha256: "b".repeat(64),
        summarizedGroupIds: ["g1"],
        recentSuffixGroupIds: [],
        sourceHighWaterSeq: 1,
        estimatedAuxiliaryTokens: 50,
        artifactVersion: 1,
        summaryText: SUMMARY,
      },
      { kind: "run_completed", text: "one" },
      { kind: "run_started", input: "run two task" },
      {
        kind: "model_response_validated",
        modelRequestId: "m2",
        attemptNo: 1,
        toolCallCount: 0,
        text: "two",
      },
      { kind: "run_completed", text: "two" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runs, 2);

    const users = result.conversation
      .filter((item) => item.kind === "user")
      .map((item) => (item.kind === "user" ? item.text : ""));

    // The compacted Run contributes the summary; the second Run keeps its own task.
    assert.equal(
      users.some((text) => text.includes("context-summary")),
      true,
    );
    assert.equal(users.includes("run two task"), true);
    assert.equal(users.includes("run one task"), false);
  });

  it("rebuilds normally when no compaction happened", async () => {
    const events = await build([
      { kind: "run_started", input: "plain task" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "ok",
      },
      { kind: "run_completed", text: "ok" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const users = result.conversation.filter((item) => item.kind === "user");
    assert.deepEqual(users, [{ kind: "user", text: "plain task" }]);
  });

  it("does not carry a summary into a later Run", async () => {
    const events = await build([
      { kind: "run_started", input: "first" },
      {
        kind: "context_compacted",
        artifactSha256: "c".repeat(64),
        summarizedGroupIds: ["g1"],
        recentSuffixGroupIds: [],
        sourceHighWaterSeq: 1,
        estimatedAuxiliaryTokens: 10,
        artifactVersion: 1,
        summaryText: SUMMARY,
      },
      { kind: "run_completed", text: "first done" },
      { kind: "run_started", input: "second" },
      {
        kind: "model_response_validated",
        modelRequestId: "m2",
        attemptNo: 1,
        toolCallCount: 0,
        text: "second done",
      },
      { kind: "run_completed", text: "second done" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Exactly one summary turn: the compacted Run's. The second Run must not inherit it.
    const summaries = result.conversation.filter(
      (item) => item.kind === "user" && item.text.includes("context-summary"),
    );
    assert.equal(summaries.length, 1);
  });
});
