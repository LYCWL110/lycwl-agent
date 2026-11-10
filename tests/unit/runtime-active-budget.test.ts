import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { RUN_BUDGET_LIMITS } from "../../src/domain/run/run-budget.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import type { ModelProvider } from "../../src/ports/model-provider.ts";
import { JsonDigest, RecordingTools, SequenceIds } from "../fakes/deterministic-services.ts";

function lastBudget(events: readonly InternalEvent[]) {
  const fact = events.findLast((event) => event.payload.kind === "run_budget_updated")?.payload;
  assert.ok(fact?.kind === "run_budget_updated");
  return fact;
}

async function waitFor(check: () => boolean) {
  for (let count = 0; count < 1000; count++) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail("wait projection unavailable");
}

function fixture(provider: ModelProvider, clock: { now: number }) {
  const tools = new RecordingTools(true, { status: "succeeded", text: "saved" });
  const runtime = new RuntimeCoordinator({
    provider,
    tools,
    approvals: { decide: async () => "approved" },
    ids: new SequenceIds(),
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    nowUtc: () => "2026-11-08T00:00:00.000Z",
    nowMs: () => clock.now,
    suspendOnApproval: true,
  });
  return { runtime, tools };
}

describe("effective Run budget", () => {
  it("stops tool dispatch after active model time reaches the Run limit", async () => {
    const clock = { now: 0 };
    const { runtime, tools } = fixture(
      {
        async complete() {
          clock.now = RUN_BUDGET_LIMITS.elapsedActiveMs;
          return {
            kind: "completed",
            text: null,
            toolCalls: [{ providerToolCallId: "call", toolName: "write_note", arguments: {} }],
          };
        },
      },
      clock,
    );
    const result = await runtime.run("work");
    assert.equal(result.safeCode, "elapsed_limit");
    assert.equal(tools.executions.length, 0);
    assert.equal(
      result.events.some((event) => event.type === "tool_dispatch_committed"),
      false,
    );
    assert.equal(lastBudget(result.events).budget.elapsedActiveMs, clock.now);
    assert.equal(lastBudget(result.events).costUnknown, true);
    const replayed = await replayRun(result.events, new JsonDigest());
    assert.ok(replayed.ok);
    assert.equal(replayed.value.budget.elapsedActiveMs, clock.now);
    assert.equal(replayed.value.costUnknown, true);
    await runtime.closeSession("close");
  });

  it("pauses time during a long approval wait without resetting spent time", async () => {
    const clock = { now: 0 };
    let sends = 0;
    const { runtime, tools } = fixture(
      {
        async complete() {
          clock.now += 100;
          return ++sends === 1
            ? {
                kind: "completed",
                text: null,
                toolCalls: [{ providerToolCallId: "call", toolName: "write_note", arguments: {} }],
              }
            : { kind: "completed", text: "done", toolCalls: [] };
        },
      },
      clock,
    );
    const running = runtime.run("work");
    await waitFor(() => runtime.pendingApprovalView() !== null);
    clock.now += 24 * 60 * 60 * 1000;
    const approval = runtime.pendingApprovalView();
    assert.ok(approval);
    await runtime.replyApproval({ ...approval, commandId: "approve", decision: "approved" });
    const result = await running;
    assert.equal(result.status, "completed");
    assert.equal(tools.executions.length, 1);
    assert.equal(lastBudget(result.events).budget.elapsedActiveMs, 200);
    await runtime.closeSession("close");
  });

  it("retains elapsed accounting across explicit configuration resume", async () => {
    const clock = { now: 0 };
    let sends = 0;
    const { runtime } = fixture(
      {
        async complete() {
          clock.now += 100;
          return ++sends === 1
            ? { kind: "authentication_failure", safeCode: "authentication_failed" }
            : { kind: "completed", text: "done", toolCalls: [] };
        },
      },
      clock,
    );
    const waiting = await runtime.run("work");
    assert.equal(waiting.run.state, "waiting");
    if (waiting.run.state !== "waiting") return;
    clock.now += 24 * 60 * 60 * 1000;
    assert.ok(
      (
        await runtime.resumeRun({
          commandId: "resume",
          waitToken: waiting.run.waitToken,
          requestVersion: waiting.run.requestVersion,
        })
      ).ok,
    );
    const result = await runtime.settle();
    assert.equal(result?.status, "completed");
    assert.ok(result);
    assert.equal(lastBudget(result.events).budget.elapsedActiveMs, 200);
    await runtime.closeSession("close");
  });

  it("counts active retry backoff and refuses the next request at the limit", async () => {
    const clock = { now: 0 };
    let sends = 0;
    const { runtime } = fixture(
      {
        async complete() {
          sends++;
          clock.now = RUN_BUDGET_LIMITS.elapsedActiveMs;
          return { kind: "transient_failure", safeCode: "temporary" };
        },
      },
      clock,
    );
    const result = await runtime.run("work");
    assert.equal(result.safeCode, "elapsed_limit");
    assert.equal(sends, 1);
    assert.equal(lastBudget(result.events).budget.modelRounds, 1);
    await runtime.closeSession("close");
  });
});
