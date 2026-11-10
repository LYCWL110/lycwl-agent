import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { EventInput } from "../../src/ports/event-log.ts";
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
  arguments: { text: "must not run" },
} as const;

type Hook = (request: ProviderRequest, index: number) => Promise<void>;

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
    await this.#hook(request, index);
    const response = this.#responses.shift();
    if (response === undefined) {
      return { kind: "invalid_response", safeCode: "script_exhausted" };
    }
    return response;
  }
}

function build(provider: ModelProvider, tools: RecordingTools) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  return {
    ids,
    eventLog,
    coordinator: new RuntimeCoordinator({
      provider,
      tools,
      approvals: new ScriptedApprovalGate(["approved"]),
      eventLog,
      ids,
      nowUtc: () => "2026-11-02T00:00:00.000Z",
      sleep: async () => undefined,
    }),
  };
}

describe("queued input superseding an undispatched response", () => {
  it("cancels the old response's calls and replans with the new input", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: "must not run" });
    let queued = false;
    const provider = new HookingProvider(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "replanned" },
      ],
      async (_request, index) => {
        if (index !== 0 || queued) return;
        queued = true;
        const result = await coordinator.queueInput("change of requirement");
        assert.equal(result.ok, true);
      },
    );
    const { coordinator, eventLog, ids } = build(provider, tools);

    const result = await coordinator.run("original task");

    assert.equal(result.status, "completed");
    assert.equal(result.text, "replanned");
    assert.equal(tools.executions.length, 0);
    assert.equal(provider.requests.length, 2);
    assert.equal(
      result.events.some((event) => event.payload.kind === "run_input_queued"),
      true,
    );
    const consumed = result.events.find(
      (event) => event.payload.kind === "run_input_batch_consumed",
    );
    assert.equal(consumed?.payload.kind, "run_input_batch_consumed");
    if (consumed?.payload.kind !== "run_input_batch_consumed") return;
    assert.equal(consumed.payload.inputIds.length, 1);
    assert.equal(consumed.payload.throughSeq, 1);
    const requests = result.events.filter(
      (event) => event.payload.kind === "model_request_started",
    );
    assert.deepEqual(
      requests.map((event) =>
        event.payload.kind === "model_request_started" ? event.payload.includedInputIds : null,
      ),
      [[], consumed.payload.inputIds],
    );
    const cancelled = result.events.find((event) => event.payload.kind === "tool_call_cancelled");
    assert.equal(cancelled?.payload.kind, "tool_call_cancelled");
    if (cancelled?.payload.kind !== "tool_call_cancelled") return;
    assert.equal(cancelled.payload.reason, "user_input_superseded");
    assert.equal(cancelled.payload.toolName, CALL.toolName);
    const lastRequest = provider.requests.at(-1);
    assert.equal(lastRequest?.conversation.at(-1)?.kind, "user");
    assert.deepEqual(
      result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
      false,
    );
    assert.equal(ids.create() !== "", true);
    assert.equal(
      (await eventLog.read(result.events[0]?.sessionId ?? "")).length,
      result.events.length,
    );
  });

  it("does not cancel calls when nothing was queued", async () => {
    const tools = new RecordingTools(false, { status: "succeeded", text: "ran" });
    const provider = new HookingProvider(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      async () => undefined,
    );
    const { coordinator } = build(provider, tools);

    const result = await coordinator.run("plain task");

    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 1);
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_call_cancelled"),
      false,
    );
    assert.equal(
      result.events.some((event) => event.payload.kind === "run_input_batch_consumed"),
      false,
    );
  });

  it("rejects input after the Run has ended", async () => {
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const provider = new HookingProvider(
      [{ kind: "completed", toolCalls: [], text: "done" }],
      async () => undefined,
    );
    const { coordinator } = build(provider, tools);

    await coordinator.run("finish quickly");

    assert.deepEqual(await coordinator.queueInput("too late"), {
      ok: false,
      code: "run_terminal",
    });
  });

  it("serializes simultaneous accepted input before consuming it", async () => {
    const tools = new RecordingTools(true, { status: "succeeded", text: null });
    const provider = new HookingProvider(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "replanned" },
      ],
      async (_request, index) => {
        if (index === 0) {
          const queued = await Promise.all(
            ["first change", "second change"].map((text) => coordinator.queueInput(text)),
          );
          assert.ok(queued.every(({ ok }) => ok));
        }
      },
    );
    const { coordinator } = build(provider, tools);
    const result = await coordinator.run("original");
    assert.equal(result.status, "completed");
    const queued = result.events.flatMap(({ payload }) =>
      payload.kind === "run_input_queued" ? [payload] : [],
    );
    assert.deepEqual(
      queued.map(({ acceptedSeq }) => acceptedSeq),
      [1, 2],
    );
    const consumed = result.events.find(
      ({ payload }) => payload.kind === "run_input_batch_consumed",
    )?.payload;
    assert.ok(consumed?.kind === "run_input_batch_consumed");
    assert.deepEqual(
      consumed.inputIds,
      queued.map(({ inputId }) => inputId),
    );
    assert.equal(tools.executions.length, 0);
  });

  it("does not expose failed input persistence to a later model request", async () => {
    const ids = new SequenceIds("failed-input");
    const log = new InMemoryEventLog(ids, new JsonDigest());
    let rejectedWrites = 0;
    const tools = new RecordingTools(false, { status: "succeeded", text: null });
    const provider = new HookingProvider(
      [
        { kind: "completed", toolCalls: [CALL], text: null },
        { kind: "completed", toolCalls: [], text: "must not send" },
      ],
      async (_request, index) => {
        if (index === 0)
          await assert.rejects(
            coordinator.queueInput("non-durable change"),
            /session_persistence_failed/,
          );
      },
    );
    const coordinator = new RuntimeCoordinator({
      ids,
      tools,
      provider,
      approvals: new ScriptedApprovalGate([]),
      eventLog: {
        read: (sessionId) => log.read(sessionId),
        append: async (input: EventInput) => {
          if (input.type === "run_input_queued") {
            rejectedWrites++;
            throw new Error("synthetic disk failure");
          }
          return log.append(input);
        },
      },
      nowUtc: () => "2026-11-08T00:00:00.000Z",
    });
    await assert.rejects(coordinator.run("original"), /session_persistence_failed/);
    assert.equal(rejectedWrites, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(tools.executions.length, 0);
    await assert.rejects(coordinator.run("new task"), /session_persistence_failed/);
  });

  it("supersedes remaining siblings when new input arrives during a tool", async () => {
    const tools = new RecordingTools(false, { status: "succeeded", text: "first done" });
    const original = tools.execute.bind(tools);
    tools.execute = async (request) => {
      const result = await original(request);
      assert.ok((await coordinator.queueInput("stop the old plan")).ok);
      return result;
    };
    const provider = new HookingProvider(
      [
        {
          kind: "completed",
          toolCalls: [CALL, { ...CALL, providerToolCallId: "second-call" }],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "replanned" },
      ],
      async () => {},
    );
    const { coordinator } = build(provider, tools);
    const result = await coordinator.run("original");
    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 1);
    assert.ok(
      result.events.some(
        ({ payload }) =>
          payload.kind === "tool_call_cancelled" &&
          payload.providerToolCallId === "second-call" &&
          payload.reason === "user_input_superseded",
      ),
    );
    assert.equal(provider.requests[1]?.conversation.at(-1)?.kind, "user");
  });
});
