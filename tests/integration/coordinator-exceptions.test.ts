import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

class ThrowingProvider implements ModelProvider {
  async complete(_request: ProviderRequest): Promise<never> {
    throw new Error("synthetic provider exception");
  }
}

describe("coordinator failure containment", () => {
  it("records a safe failed terminal state when a dependency throws", async () => {
    const ids = new SequenceIds("exception");
    const digests = new JsonDigest();
    const eventLog = new InMemoryEventLog(ids, digests);
    const coordinator = new RuntimeCoordinator({
      provider: new ThrowingProvider(),
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog,
      ids,
      nowUtc: () => "2026-11-02T00:00:00.000Z",
    });

    const result = await coordinator.run("throwing provider");

    assert.equal(result.status, "failed");
    assert.equal(result.run.state, "failed");
    assert.equal(result.safeCode, "unexpected_internal_error");
    assert.equal(result.events.at(-1)?.payload.kind, "run_failed");
    assert.equal(
      result.events.some((event) =>
        JSON.stringify(event).includes("synthetic provider exception"),
      ),
      false,
    );
  });
});
