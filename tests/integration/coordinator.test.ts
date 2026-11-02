import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "write_note",
  arguments: { text: "synthetic" },
} as const;

function dependencies(
  provider: ScriptedProvider,
  tools: RecordingTools,
  approvals: ScriptedApprovalGate,
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  return {
    ids,
    digests,
    eventLog,
    coordinator: new RuntimeCoordinator({
      provider,
      tools,
      approvals,
      eventLog,
      ids,
      nowUtc: () => "2026-11-02T00:00:00.000Z",
      sleep: async () => undefined,
    }),
  };
}

describe("deterministic Runtime coordinator", () => {
  it("executes one approved fake tool and replays the completed Run", async () => {
    const provider = new ScriptedProvider([
      { kind: "completed", toolCalls: [CALL], text: null },
      { kind: "completed", toolCalls: [], text: "done" },
    ]);
    const tools = new RecordingTools(true, { status: "succeeded", text: "synthetic result" });
    const approvals = new ScriptedApprovalGate(["approved"]);
    const { coordinator, eventLog, digests } = dependencies(provider, tools, approvals);

    const result = await coordinator.run("perform synthetic task");

    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
    assert.equal(tools.executions.length, 1);
    assert.equal(approvals.requests.length, 1);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1]?.conversation.at(-1)?.kind, "tool_result");

    const replayed = await replayRun(await eventLog.read(result.events[0]?.sessionId ?? ""), digests);
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.value.state, "completed");
    assert.equal(replayed.value.finalText, "done");
    const finished = result.events.find(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished?.payload.kind, "tool_execution_finished");
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(replayed.value.toolOutcomes[finished.payload.toolCallId], "succeeded");
  });

  it("reports a denied mutation to the Provider without executing it", async () => {
    const provider = new ScriptedProvider([
      { kind: "completed", toolCalls: [CALL], text: null },
      { kind: "completed", toolCalls: [], text: "continued after denial" },
    ]);
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    const approvals = new ScriptedApprovalGate(["denied"]);
    const { coordinator } = dependencies(provider, tools, approvals);

    const result = await coordinator.run("request denied task");

    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 0);
    assert.equal(provider.requests[1]?.conversation.at(-1)?.status, "denied");
  });

  it("fails an invalid Provider response before tool dispatch", async () => {
    const provider = new ScriptedProvider([
      { kind: "invalid_response", safeCode: "invalid_tool_call" },
    ]);
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate([]));

    const result = await coordinator.run("invalid response task");

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "invalid_tool_call");
    assert.equal(tools.executions.length, 0);
  });

  it("rejects duplicate Provider tool-call IDs in one response", async () => {
    const provider = new ScriptedProvider([
      {
        kind: "completed",
        toolCalls: [CALL, CALL],
        text: null,
      },
    ]);
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate([]));

    const result = await coordinator.run("duplicate call task");

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "duplicate_provider_tool_call_id");
    assert.equal(tools.executions.length, 0);
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_call_received"),
      false,
    );
  });

  it("retries transient failures at most twice and records both retries", async () => {
    const provider = new ScriptedProvider([
      { kind: "transient_failure", safeCode: "temporary_1", retryAfterMs: 1 },
      { kind: "transient_failure", safeCode: "temporary_2", retryAfterMs: 2 },
      { kind: "completed", toolCalls: [], text: "recovered" },
    ]);
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate([]));

    const result = await coordinator.run("retry task");

    assert.equal(result.status, "completed");
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(
      provider.requests.map((request) => request.attemptNo),
      [1, 2, 3],
    );
    assert.equal(
      result.events.filter((event) => event.payload.kind === "model_retry_scheduled").length,
      2,
    );
  });

  it("fails after three transient attempts without a fourth send", async () => {
    const provider = new ScriptedProvider([
      { kind: "transient_failure", safeCode: "temporary_1" },
      { kind: "transient_failure", safeCode: "temporary_2" },
      { kind: "transient_failure", safeCode: "temporary_3" },
      { kind: "completed", toolCalls: [], text: "must not be requested" },
    ]);
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate([]));

    const result = await coordinator.run("exhaust retries");

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "transient_retries_exhausted");
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(
      provider.requests.map((request) => request.attemptNo),
      [1, 2, 3],
    );
  });

  it("waits for configuration after authentication failure", async () => {
    const provider = new ScriptedProvider([
      { kind: "authentication_failure", safeCode: "authentication_failed" },
    ]);
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate([]));

    const result = await coordinator.run("authentication task");

    assert.equal(result.status, "waiting");
    assert.equal(result.run.state, "waiting");
    assert.equal(result.safeCode, "authentication_failed");
  });

  it("turns an unknown tool outcome into a failed Run and does not dispatch a sibling", async () => {
    const secondCall = {
      providerToolCallId: "provider-call-2",
      toolName: "write_note",
      arguments: { text: "must not run" },
    } as const;
    const provider = new ScriptedProvider([
      {
        kind: "completed",
        toolCalls: [CALL, secondCall],
        text: null,
      },
    ]);
    const tools = new RecordingTools(true, {
      status: "outcome_unknown",
      safeCode: "synthetic_unknown",
    });
    const { coordinator } = dependencies(provider, tools, new ScriptedApprovalGate(["approved"]));

    const result = await coordinator.run("unknown outcome task");

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "tool_outcome_unknown");
    assert.equal(tools.executions.length, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.run.state, "failed");
    const unknownEvent = result.events.find(
      (event) =>
        event.payload.kind === "tool_execution_finished" &&
        event.payload.status === "outcome_unknown",
    );
    assert.notEqual(unknownEvent, undefined);
    assert.equal(
      result.events.at(-1)?.payload.kind,
      "run_failed",
    );
  });
});
