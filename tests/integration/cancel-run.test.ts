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
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "write_note",
  arguments: { text: "synthetic" },
} as const;

type Hook = (index: number) => Promise<void>;

class HookingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ProviderCompletion[];
  readonly #hook: Hook;

  constructor(responses: readonly ProviderCompletion[], hook: Hook) {
    this.#responses = [...responses];
    this.#hook = hook;
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    const index = this.requests.length;
    this.requests.push(request);
    await this.#hook(index);
    return this.#responses.shift() ?? { kind: "invalid_response", safeCode: "script_exhausted" };
  }
}

function build(provider: ModelProvider, tools: RecordingTools) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider,
    tools,
    approvals: new ScriptedApprovalGate(["approved"]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { ids, digests, eventLog, coordinator };
}

describe("CancelRun", () => {
  it("cancels before the next dispatch when requested during a model request", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    let requested = false;
    const provider = new HookingProvider(
      [{ kind: "completed", toolCalls: [CALL], text: null }],
      async (index) => {
        if (index !== 0 || requested) return;
        requested = true;
        const outcome = await coordinator.cancelRun("cancel-1");
        assert.deepEqual(outcome, { ok: true, duplicate: false });
      },
    );
    const { coordinator, eventLog, digests } = build(provider, tools);

    const result = await coordinator.run("task to cancel");

    assert.equal(result.status, "cancelled");
    assert.equal(result.safeCode, "run_cancelled");
    assert.equal(result.run.state, "cancelled");
    assert.equal(tools.executions.length, 0);
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
      false,
    );
    assert.equal(
      result.events.some((event) => event.payload.kind === "run_cancel_requested"),
      true,
    );
    assert.equal(result.events.at(-1)?.payload.kind, "run_cancelled");

    const replayed = await replayRun(
      await eventLog.read(result.events[0]?.sessionId ?? ""),
      digests,
    );
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.value.state, "cancelled");
  });

  it("stops after an executing call and preserves its actual result", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "already ran" });
    let requested = false;
    const provider = new HookingProvider(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "must not be requested" },
      ],
      async () => {
        if (requested) return;
        requested = true;
      },
    );
    const { coordinator } = build(provider, tools);
    const original = tools.execute.bind(tools);
    tools.execute = async (request) => {
      const result = await original(request);
      await coordinator.cancelRun("cancel-late");
      return result;
    };

    const result = await coordinator.run("cancel during execution");

    assert.equal(result.status, "cancelled");
    assert.equal(tools.executions.length, 1);
    assert.equal(provider.requests.length, 1);
    const finished = result.events.find(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished?.payload.kind, "tool_execution_finished");
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.equal(finished.payload.text, "already ran");
  });

  it("is idempotent for a repeated command id", async () => {
    let outcomes: unknown[] = [];
    const provider = new HookingProvider(
      [{ kind: "completed", toolCalls: [], text: "done" }],
      async () => {
        outcomes = [
          await coordinator.cancelRun("cancel-dup"),
          await coordinator.cancelRun("cancel-dup"),
        ];
      },
    );
    const { coordinator } = build(
      provider,
      new RecordingTools(false, { status: "succeeded", text: null }),
    );

    await coordinator.run("duplicate cancel");

    assert.deepEqual(outcomes, [
      { ok: true, duplicate: false },
      { ok: true, duplicate: true },
    ]);
  });

  it("rejects cancellation with an empty command id or after the Run ended", async () => {
    const provider = new HookingProvider(
      [{ kind: "completed", toolCalls: [], text: "done" }],
      async () => undefined,
    );
    const { coordinator } = build(
      provider,
      new RecordingTools(false, { status: "succeeded", text: null }),
    );

    assert.deepEqual(await coordinator.cancelRun(""), {
      ok: false,
      code: "invalid_identity",
    });
    await coordinator.run("finish before cancelling");
    assert.deepEqual(await coordinator.cancelRun("cancel-too-late"), {
      ok: false,
      code: "run_terminal",
    });
  });
});
