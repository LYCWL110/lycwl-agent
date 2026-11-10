import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInternalEvent } from "../../src/adapters/persistence/internal-event-validation.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { deriveTaskReport } from "../../src/application/task-report/derive-task-report.ts";
import { aggregateVerification } from "../../src/domain/evidence/verification.ts";
import { InMemoryEventLog } from "../../src/ports/event-log.ts";
import { JsonDigest, RecordingTools, SequenceIds } from "../fakes/deterministic-services.ts";

describe("reported token usage is not an unknown charge", () => {
  /**
   * The previous rule marked every request as an unknown charge because no usage
   * was ever captured. Now that adapters report usage, a request that reported
   * tokens has a known count and must not be counted as unknown.
   */
  it("counts zero unknown charges when every request reported usage", async () => {
    const log = new InMemoryEventLog(new SequenceIds("event"), new JsonDigest());
    const runtime = new RuntimeCoordinator({
      ids: new SequenceIds(),
      eventLog: log,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      tools: new RecordingTools(false, { status: "succeeded", text: "ok" }),
      approvals: { decide: async () => "denied" },
      provider: {
        complete: async () => ({
          kind: "completed",
          text: "done",
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
      },
      persistReports: true,
    });
    const result = await runtime.run("report usage");
    const event = result.events.at(-1);
    assert.ok(event?.payload.kind === "task_report_snapshot");
    assert.equal(event.payload.report.usage.unknownChargeCount, 0);
  });

  it("counts only the requests that reported nothing", async () => {
    // Two rounds: the first reports usage, the second does not.
    let call = 0;
    const log = new InMemoryEventLog(new SequenceIds("event"), new JsonDigest());
    const runtime = new RuntimeCoordinator({
      ids: new SequenceIds(),
      eventLog: log,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      tools: new RecordingTools(false, { status: "succeeded", text: "ok" }),
      approvals: { decide: async () => "denied" },
      provider: {
        complete: async () => {
          call += 1;
          if (call === 1) {
            return {
              kind: "completed",
              text: null,
              toolCalls: [{ providerToolCallId: "c1", toolName: "probe", arguments: { n: 1 } }],
              usage: { inputTokens: 50, outputTokens: 5 },
            };
          }
          return { kind: "completed", text: "done", toolCalls: [] };
        },
      },
      persistReports: true,
    });
    const result = await runtime.run("mixed usage");
    const event = result.events.at(-1);
    assert.ok(event?.payload.kind === "task_report_snapshot");
    assert.equal(event.payload.report.usage.unknownChargeCount, 1);
  });
});

describe("fact-derived task report", () => {
  it("never treats a model claim with a source locator as an independent check", () => {
    for (const state of ["passed", "failed"] as const) {
      const result = aggregateVerification([
        {
          assertionId: "model-claim",
          kind: "model_claim",
          description: "the model says it checked",
          state,
          applicability: "current",
          evidence: [{ kind: "event", sessionId: "session", eventId: "event", seq: 1 }],
          unavailableEvidence: [],
          required: true,
        },
      ]);
      assert.equal(result.status, "unverified");
      assert.equal(result.perAssertion[0]?.status, "unverified");
    }
  });
  it("persists an unverified terminal report even when the model claims success", async () => {
    const log = new InMemoryEventLog(new SequenceIds("event"), new JsonDigest());
    const runtime = new RuntimeCoordinator({
      ids: new SequenceIds(),
      eventLog: log,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      tools: new RecordingTools(false, { status: "succeeded", text: "ok" }),
      approvals: { decide: async () => "denied" },
      provider: {
        complete: async () => ({
          kind: "completed",
          text: "All tests pass; the task is verified.",
          toolCalls: [],
        }),
      },
      persistReports: true,
    });
    const result = await runtime.run("repair the application");
    const event = result.events.at(-1);
    assert.ok(event?.payload.kind === "task_report_snapshot");
    assert.ok(isInternalEvent(event));
    assert.equal(event.payload.report.verification.status, "unverified");
    assert.equal(event.payload.report.sourceHighWaterSeq, event.seq - 1);
    assert.deepEqual(event.payload.report.tests, []);
    assert.equal(event.payload.report.usage.unknownChargeCount, 1);
    const rebuilt = deriveTaskReport(result.events, event.sessionId, event.runId);
    assert.ok(rebuilt.ok);
    assert.equal(rebuilt.value.verification.status, "unverified");
    const replayed = await replayRun(result.events, new JsonDigest());
    assert.ok(replayed.ok);
    assert.equal(replayed.value.state, "completed");
    assert.equal(
      isInternalEvent({
        ...event,
        payload: {
          ...event.payload,
          report: {
            ...event.payload.report,
            verification: {
              ...event.payload.report.verification,
              status: "verified",
            },
          },
        },
      }),
      false,
    );
    assert.equal(
      isInternalEvent({
        ...event,
        payload: { ...event.payload, report: { ...event.payload.report, sessionId: "foreign" } },
      }),
      false,
    );
    await runtime.closeSession("close");
  });
});
