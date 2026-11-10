import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rebuildConversation,
  trimConversation,
} from "../../src/application/coordinator/conversation-rebuild.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import type { InternalEvent, InternalEventPayload } from "../../src/ports/event-log.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * Rebuilding a conversation from events.
 *
 * ADR-0055 records that persistence kept the record but a restart did not rebuild
 * context. These tests drive the real event log, so the shape under test is the one
 * that actually reaches disk.
 */

async function build(events: readonly InternalEventPayload[]): Promise<readonly InternalEvent[]> {
  const ids = new SequenceIds("ev");
  const digests = new JsonDigest();
  const log = new InMemoryEventLog(ids, digests);
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

const CALL_ARGS = { path: "a.ts" };

describe("conversation rebuild", () => {
  it("rebuilds a completed run with a tool round trip", async () => {
    const events = await build([
      { kind: "run_started", input: "read a.ts" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 1,
        text: "looking",
      },
      {
        kind: "tool_call_received",
        toolCallId: "tc1",
        providerToolCallId: "p1",
        toolName: "read_file",
        arguments: CALL_ARGS,
      },
      {
        kind: "tool_execution_finished",
        toolCallId: "tc1",
        status: "succeeded",
        safeCode: null,
        text: "file body",
        toolName: "read_file",
      },
      {
        kind: "model_response_validated",
        modelRequestId: "m2",
        attemptNo: 1,
        toolCallCount: 0,
        text: "done",
      },
      { kind: "run_completed", text: "done" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;

    assert.equal(result.runs, 1);
    // The first assistant turn carried the call; the second replaced the text.
    const user = result.conversation[0];
    assert.deepEqual(user, { kind: "user", text: "read a.ts" });

    const assistant = result.conversation[1];
    assert.ok(assistant);
    assert.equal(assistant.kind, "assistant");
    if (assistant.kind !== "assistant") return;
    assert.deepEqual(assistant.toolCalls, [
      { providerToolCallId: "p1", toolName: "read_file", arguments: CALL_ARGS },
    ]);

    const toolResult = result.conversation[2];
    assert.ok(toolResult);
    assert.equal(toolResult.kind, "tool_result");
    if (toolResult.kind !== "tool_result") return;
    assert.equal(toolResult.providerToolCallId, "p1");
    assert.equal(toolResult.status, "succeeded");
    assert.equal(toolResult.text, "file body");
  });

  it("preserves a denied result status", async () => {
    const events = await build([
      { kind: "run_started", input: "delete it" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 1,
        text: null,
      },
      {
        kind: "tool_call_received",
        toolCallId: "tc1",
        providerToolCallId: "p1",
        toolName: "delete_path",
        arguments: { path: "a.ts" },
      },
      { kind: "tool_execution_denied", toolCallId: "tc1", toolName: "delete_path" },
      { kind: "run_completed", text: "acknowledged" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const toolResult = result.conversation.find((item) => item.kind === "tool_result");
    assert.ok(toolResult);
    if (toolResult?.kind !== "tool_result") return;
    assert.equal(toolResult.status, "denied");
  });

  it("preserves an unknown outcome rather than upgrading it", async () => {
    const events = await build([
      { kind: "run_started", input: "run it" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 1,
        text: null,
      },
      {
        kind: "tool_call_received",
        toolCallId: "tc1",
        providerToolCallId: "p1",
        toolName: "shell",
        arguments: { command: "x" },
      },
      {
        kind: "tool_execution_finished",
        toolCallId: "tc1",
        status: "outcome_unknown",
        safeCode: "shell_outcome_unknown",
        text: null,
        toolName: "shell",
      },
      { kind: "run_failed", safeCode: "tool_outcome_unknown" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const toolResult = result.conversation.find((item) => item.kind === "tool_result");
    assert.ok(toolResult);
    if (toolResult?.kind !== "tool_result") return;
    assert.equal(toolResult.status, "outcome_unknown");
  });

  it("rebuilds multiple runs in order", async () => {
    const events = await build([
      { kind: "run_started", input: "first" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "a",
      },
      { kind: "run_completed", text: "a" },
      { kind: "run_started", input: "second" },
      {
        kind: "model_response_validated",
        modelRequestId: "m2",
        attemptNo: 1,
        toolCallCount: 0,
        text: "b",
      },
      { kind: "run_completed", text: "b" },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runs, 2);
    const users = result.conversation.filter((item) => item.kind === "user");
    assert.deepEqual(
      users.map((item) => (item.kind === "user" ? item.text : "")),
      ["first", "second"],
    );
  });

  it("skips a run that never reached a terminal event", async () => {
    const events = await build([
      { kind: "run_started", input: "unfinished" },
      {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "partial",
      },
    ]);

    const result = rebuildConversation(events);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // An in-flight Run is dropped rather than guessed at.
    assert.equal(result.runs, 0);
    assert.deepEqual(result.conversation, []);
  });

  it("returns an empty conversation for an empty log", () => {
    const result = rebuildConversation([]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.conversation, []);
    assert.equal(result.runs, 0);
  });
});

describe("trimConversation", () => {
  const conversation = [
    { kind: "user" as const, text: "one" },
    { kind: "assistant" as const, text: "a", toolCalls: [] },
    { kind: "user" as const, text: "two" },
    { kind: "assistant" as const, text: "b", toolCalls: [] },
    { kind: "user" as const, text: "three" },
  ];

  it("returns everything when within budget", () => {
    assert.deepEqual(trimConversation(conversation, 10), conversation);
  });

  it("cuts at a user-turn boundary", () => {
    const trimmed = trimConversation(conversation, 3);
    // The cut must not start in the middle of a turn.
    assert.equal(trimmed[0]?.kind, "user");
    assert.equal(trimmed.length <= 3, true);
  });

  it("returns nothing for a non-positive budget", () => {
    assert.deepEqual(trimConversation(conversation, 0), []);
  });
});
