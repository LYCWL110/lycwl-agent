import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

function fixture() {
  const provider = new ScriptedProvider([
    { kind: "authentication_failure", safeCode: "invalid_key" },
    { kind: "completed", text: "done", toolCalls: [] },
  ]);
  const coordinator = new RuntimeCoordinator({
    provider,
    tools: new RecordingTools(false, { status: "succeeded", text: "" }),
    approvals: { decide: async () => "denied" },
    ids: new SequenceIds(),
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    nowUtc: () => "2026-11-08T00:00:00.000Z",
  });
  const keys: string[] = [];
  const controller = createTuiController({
    coordinator,
    correctCredential: async (secret) => {
      keys.push(secret);
      return secret.length > 0;
    },
  });
  return { coordinator, provider, controller, keys };
}

describe("configuration correction and explicit resume", () => {
  it("corrects only the bound key and never resumes from save or ordinary input", async () => {
    const { coordinator, controller, provider, keys } = fixture();
    await controller.submit("/key");
    assert.equal(controller.view().localPanel, null);
    await controller.submit("work");
    assert.equal(controller.view().waitingKind, "configuration");
    await controller.submit("/config");
    assert.equal(controller.takeNavigationRequest(), null);
    await controller.submit("/model");
    assert.equal(controller.takeNavigationRequest(), null);
    await controller.submit("/key");
    assert.equal(controller.view().localPanel, "credential");
    assert.ok(await controller.correctCredential?.("SYNTHETIC_REPLACEMENT"));
    assert.deepEqual(keys, ["SYNTHETIC_REPLACEMENT"]);
    assert.equal(provider.requests.length, 1);
    assert.ok(coordinator.configurationWaitView());
    assert.equal(JSON.stringify(controller.view()).includes("SYNTHETIC_REPLACEMENT"), false);
    await controller.submit("/resume");
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0]?.modelRequestId, provider.requests[1]?.modelRequestId);
    assert.deepEqual(
      provider.requests.map((request) => request.attemptNo),
      [1, 2],
    );
    assert.equal(controller.lastResult()?.status, "completed");
    await controller.close();
  });

  it("does not reset request attempts or model rounds across repeated authentication repairs", async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 3 }, () => ({
        kind: "authentication_failure" as const,
        safeCode: "invalid_key",
      })),
    );
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: new RecordingTools(false, { status: "succeeded", text: "" }),
      approvals: { decide: async () => "denied" },
      ids: new SequenceIds(),
      eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
      nowUtc: () => "2026-11-08T00:00:00.000Z",
    });
    await coordinator.run("work");
    for (let count = 0; count < 3; count++) {
      const wait = coordinator.configurationWaitView();
      assert.ok(wait);
      assert.ok((await coordinator.resumeRun({ ...wait, commandId: `resume-${count}` })).ok);
      await coordinator.settle();
    }
    assert.deepEqual(
      provider.requests.map((request) => request.attemptNo),
      [1, 2, 3],
    );
    assert.equal(new Set(provider.requests.map((request) => request.modelRequestId)).size, 1);
    const result = coordinator.lastRunResult();
    assert.equal(result?.safeCode, "attempt_limit");
    const budget = result?.events.findLast(
      (event) => event.payload.kind === "run_budget_updated",
    )?.payload;
    assert.ok(budget?.kind === "run_budget_updated");
    assert.equal(budget.budget.modelRounds, 1);
    await coordinator.closeSession("close");
  });

  it("cancels a settled configuration wait so another Run is not stuck busy", async () => {
    const { controller, coordinator } = fixture();
    await controller.submit("work");
    assert.equal(controller.view().runStatus, "waiting");
    await controller.submit("/cancel");
    assert.equal(controller.view().runStatus, "cancelled");
    assert.equal(coordinator.configurationWaitView(), null);
    await controller.submit("new work");
    assert.equal(controller.lastResult()?.status, "completed");
    await controller.close();
  });
});
