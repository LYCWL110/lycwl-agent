import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

class AuthThenSuccessProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  #first = true;

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    if (this.#first) {
      this.#first = false;
      return { kind: "authentication_failure", safeCode: "authentication_failed" };
    }
    return { kind: "completed", toolCalls: [], text: "done after resume" };
  }
}

function coordinatorWith(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly {
      providerToolCallId: string;
      toolName: string;
      arguments: unknown;
    }[];
    text: string | null;
  }[],
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools: new RecordingTools(false, { status: "succeeded", text: null }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { digests, eventLog, coordinator };
}

function authCoordinator() {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const provider = new AuthThenSuccessProvider();
  const coordinator = new RuntimeCoordinator({
    provider,
    tools: new RecordingTools(false, { status: "succeeded", text: null }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { provider, digests, eventLog, coordinator };
}

describe("configuration wait and ResumeRun", () => {
  it("stays waiting until an explicit matching ResumeRun", async () => {
    const { coordinator, eventLog, digests } = authCoordinator();

    const first = await coordinator.run("authentication task");

    assert.equal(first.status, "waiting");
    assert.equal(first.run.state, "waiting");
    assert.equal(first.safeCode, "authentication_failed");
    const waiting = first.events.find((event) => event.payload.kind === "run_waiting");
    assert.equal(waiting?.payload.kind, "run_waiting");
    if (waiting?.payload.kind !== "run_waiting") return;
    assert.equal(waiting.payload.reason, "configuration");
    assert.equal(waiting.payload.requestVersion, 1);
    const waitToken = waiting.payload.waitToken;
    assert.equal(waitToken.length > 0, true);

    assert.deepEqual(
      await coordinator.resumeRun({
        commandId: "resume-1",
        waitToken: "wrong-token",
        requestVersion: 1,
      }),
      { ok: false, code: "not_waiting_for_configuration" },
    );

    assert.deepEqual(
      await coordinator.resumeRun({
        commandId: "resume-2",
        waitToken,
        requestVersion: 1,
      }),
      { ok: true, duplicate: false },
    );

    const settled = await coordinator.settle();
    assert.notEqual(settled, null);
    if (settled === null) return;
    assert.equal(settled.status, "completed");
    assert.equal(settled.text, "done after resume");
    assert.equal(
      settled.events.some((event) => event.payload.kind === "run_resumed"),
      true,
    );

    const replayed = await replayRun(
      await eventLog.read(settled.events[0]?.sessionId ?? ""),
      digests,
    );
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.value.state, "completed");
  });

  it("rejects resume for a Run that is not waiting for configuration", async () => {
    const { coordinator } = coordinatorWith([{ kind: "completed", toolCalls: [], text: "done" }]);

    await coordinator.run("plain task");

    assert.deepEqual(
      await coordinator.resumeRun({
        commandId: "resume-x",
        waitToken: "token-x",
        requestVersion: 1,
      }),
      { ok: false, code: "run_terminal" },
    );
  });

  it("rejects an empty resume identity", async () => {
    const { coordinator } = coordinatorWith([{ kind: "completed", toolCalls: [], text: "done" }]);

    assert.deepEqual(
      await coordinator.resumeRun({ commandId: "", waitToken: "token", requestVersion: 1 }),
      { ok: false, code: "invalid_identity" },
    );
  });
});
