import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderDelta,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

class StreamingProvider implements ModelProvider {
  readonly #release: () => void;
  readonly #gate: Promise<void>;
  readonly requests: ProviderRequest[] = [];

  constructor() {
    let release: () => void = () => undefined;
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#release = release;
  }

  release(): void {
    this.#release();
  }

  complete(): Promise<ProviderCompletion> {
    return Promise.reject(new Error("complete must not be used for a streaming run"));
  }

  async stream(
    request: ProviderRequest,
    onDelta: (delta: ProviderDelta) => void,
  ): Promise<ProviderCompletion> {
    this.requests.push(request);
    onDelta({ kind: "text", text: "hel" });
    await this.#gate;
    onDelta({ kind: "text", text: "lo" });
    return { kind: "completed", toolCalls: [], text: "hello" };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

describe("streaming model output", () => {
  it("exposes ephemeral text during a Run and persists only the final response", async () => {
    const ids = new SequenceIds("stream");
    const digests = new JsonDigest();
    const eventLog = new InMemoryEventLog(ids, digests);
    const provider = new StreamingProvider();
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog,
      ids,
      nowUtc: () => "2026-11-24T00:00:00.000Z",
      sleep: async () => undefined,
    });

    const running = coordinator.run("stream this");
    await waitFor(() => coordinator.currentRunProjection()?.streaming?.text === "hel");
    assert.deepEqual(coordinator.currentRunProjection()?.streaming, { text: "hel" });

    provider.release();
    const result = await running;
    assert.equal(result.status, "completed");
    assert.equal(result.text, "hello");
    const validated = result.events.filter(
      (event) => event.payload.kind === "model_response_validated",
    );
    assert.equal(validated.length, 1);
    const validatedPayload = validated[0]?.payload;
    if (validatedPayload?.kind === "model_response_validated") {
      assert.equal(validatedPayload.text, "hello");
    }
    assert.equal(coordinator.currentRunProjection(), null);
  });
});
