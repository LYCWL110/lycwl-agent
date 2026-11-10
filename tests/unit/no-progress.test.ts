import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CallFingerprint,
  type CallRecord,
  checkIdenticalCall,
  checkRecoveryFailures,
  classifyStreamEvent,
  evaluateStreamProgress,
  type FailureFingerprint,
  isObservedBackgroundPoll,
  NO_PROGRESS_LIMITS,
  resumeDetectionWindow,
} from "../../src/domain/run/no-progress.ts";

const fingerprint: CallFingerprint = {
  toolName: "read_file",
  toolVersion: "1",
  normalizedInput: '{"path":"a.ts"}',
  resourceVersion: "sha-a",
};

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    fingerprint,
    status: "succeeded",
    failure: null,
    ...overrides,
  };
}

describe("identical call detection", () => {
  it("proceeds on the first call", () => {
    assert.deepEqual(checkIdenticalCall({ fingerprint, history: [], hasNewUserInput: false }), {
      kind: "proceed",
    });
  });

  it("warns after the second identical result", () => {
    const decision = checkIdenticalCall({
      fingerprint,
      history: [record()],
      hasNewUserInput: false,
    });
    // The first record exists, so this would be the second identical call.
    assert.equal(decision.kind, "warn");
    if (decision.kind !== "warn") return;
    assert.equal(decision.reason, "no_progress");
  });

  it("blocks before the third identical call", () => {
    const decision = checkIdenticalCall({
      fingerprint,
      history: [record(), record()],
      hasNewUserInput: false,
    });
    assert.equal(decision.kind, "block");
    if (decision.kind !== "block") return;
    assert.equal(decision.blockedToolName, "read_file");
  });

  it("does not count a changed resource version as identical", () => {
    const changed = record({
      fingerprint: { ...fingerprint, resourceVersion: "sha-b" },
    });
    const decision = checkIdenticalCall({
      fingerprint,
      history: [changed, changed],
      hasNewUserInput: false,
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });

  it("does not count a different tool version as identical", () => {
    const changed = record({ fingerprint: { ...fingerprint, toolVersion: "2" } });
    const decision = checkIdenticalCall({
      fingerprint,
      history: [changed, changed],
      hasNewUserInput: false,
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });

  it("resets when new user input arrived", () => {
    const decision = checkIdenticalCall({
      fingerprint,
      history: [record(), record()],
      hasNewUserInput: true,
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });

  it("does not let a different tool's records count", () => {
    const other = record({
      fingerprint: { ...fingerprint, toolName: "glob" },
    });
    const decision = checkIdenticalCall({
      fingerprint,
      history: [other, other],
      hasNewUserInput: false,
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });
});

describe("background polling is not a stall", () => {
  it("treats a running task with new output as progress", () => {
    assert.equal(
      isObservedBackgroundPoll({
        toolName: "background_output",
        taskStillRunning: true,
        observedNewOutput: true,
      }),
      true,
    );
  });

  it("does not treat a running task with no new output as progress", () => {
    assert.equal(
      isObservedBackgroundPoll({
        toolName: "background_output",
        taskStillRunning: true,
        observedNewOutput: false,
      }),
      false,
    );
  });

  it("does not apply to a finished task", () => {
    assert.equal(
      isObservedBackgroundPoll({
        toolName: "background_output",
        taskStillRunning: false,
        observedNewOutput: true,
      }),
      false,
    );
  });

  it("does not apply to a non-background tool", () => {
    assert.equal(
      isObservedBackgroundPoll({
        toolName: "read_file",
        taskStillRunning: true,
        observedNewOutput: true,
      }),
      false,
    );
  });
});

describe("recovery path failures", () => {
  const failure: FailureFingerprint = {
    category: "tool_failure",
    code: "nonzero_exit",
    stage: "execute",
  };

  function history(count: number, pathId = "p1") {
    return Array.from({ length: count }, () => ({ pathId, failure }));
  }

  it("proceeds on the first two failures", () => {
    assert.deepEqual(checkRecoveryFailures({ pathId: "p1", failure, history: [] }), {
      kind: "proceed",
    });
    assert.deepEqual(checkRecoveryFailures({ pathId: "p1", failure, history: history(1) }), {
      kind: "proceed",
    });
  });

  it("warns on the third equivalent failure", () => {
    const decision = checkRecoveryFailures({ pathId: "p1", failure, history: history(2) });
    assert.equal(decision.kind, "warn");
  });

  it("waits on the fifth equivalent failure", () => {
    const decision = checkRecoveryFailures({ pathId: "p1", failure, history: history(4) });
    assert.equal(decision.kind, "wait");
    if (decision.kind !== "wait") return;
    assert.equal(decision.reason, "recovery_review");
  });

  it("does not accumulate across different recovery paths", () => {
    const decision = checkRecoveryFailures({
      pathId: "p2",
      failure,
      history: history(4, "p1"),
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });

  it("does not accumulate across different failure identities", () => {
    const other: FailureFingerprint = {
      category: "timeout",
      code: "idle_timeout",
      stage: "stream",
    };
    const decision = checkRecoveryFailures({
      pathId: "p1",
      failure,
      history: [
        { pathId: "p1", failure: other },
        { pathId: "p1", failure: other },
        { pathId: "p1", failure: other },
        { pathId: "p1", failure: other },
      ],
    });
    assert.deepEqual(decision, { kind: "proceed" });
  });

  it("starts a new window after an explicit resume without erasing history", () => {
    const before = history(4);
    const resumed = resumeDetectionWindow({ history: before, pathId: "p1", failure });
    assert.equal(resumed.history.length, before.length + 1);
    // The boundary ends the trailing run, so the next failure proceeds again.
    assert.deepEqual(checkRecoveryFailures({ pathId: "p1", failure, history: resumed.history }), {
      kind: "proceed",
    });
  });

  it("waits again when the threshold is reached after a resume", () => {
    const before = history(4);
    const resumed = resumeDetectionWindow({ history: before, pathId: "p1", failure });
    const after = [...resumed.history, ...history(4)];
    const decision = checkRecoveryFailures({ pathId: "p1", failure, history: after });
    assert.equal(decision.kind, "wait");
  });
});

describe("model stream progress", () => {
  it("continues before the first-event threshold", () => {
    assert.deepEqual(
      evaluateStreamProgress({
        elapsedMs: 1_000,
        sinceEffectiveMs: 1_000,
        sawEffectiveEvent: false,
      }),
      { kind: "continue" },
    );
  });

  it("aborts when no effective event arrives within 90s", () => {
    const verdict = evaluateStreamProgress({
      elapsedMs: NO_PROGRESS_LIMITS.firstEffectiveEventMs,
      sinceEffectiveMs: NO_PROGRESS_LIMITS.firstEffectiveEventMs,
      sawEffectiveEvent: false,
    });
    assert.equal(verdict.kind, "abort");
    if (verdict.kind !== "abort") return;
    assert.equal(verdict.reason, "first_event_timeout");
  });

  it("aborts after 60s idle once content has arrived", () => {
    const verdict = evaluateStreamProgress({
      elapsedMs: 100_000,
      sinceEffectiveMs: NO_PROGRESS_LIMITS.idleAfterEffectiveEventMs,
      sawEffectiveEvent: true,
    });
    assert.equal(verdict.kind, "abort");
    if (verdict.kind !== "abort") return;
    assert.equal(verdict.reason, "idle_timeout");
  });

  it("does not abort a slow normal stream inside the idle window", () => {
    assert.deepEqual(
      evaluateStreamProgress({
        elapsedMs: 100_000,
        sinceEffectiveMs: 1_000,
        sawEffectiveEvent: true,
      }),
      { kind: "continue" },
    );
  });

  it("lets the existing attempt cap own the over-cap case", () => {
    // Detection must not add a second, competing timeout.
    assert.deepEqual(
      evaluateStreamProgress({
        elapsedMs: NO_PROGRESS_LIMITS.attemptCapMs,
        sinceEffectiveMs: NO_PROGRESS_LIMITS.attemptCapMs,
        sawEffectiveEvent: false,
      }),
      { kind: "continue" },
    );
  });
});

describe("stream event classification", () => {
  it("counts a non-empty text delta as effective", () => {
    assert.equal(classifyStreamEvent({ kind: "text_delta", hasContent: true }), "effective");
  });

  it("counts a non-empty tool argument delta as effective", () => {
    assert.equal(
      classifyStreamEvent({ kind: "tool_argument_delta", hasContent: true }),
      "effective",
    );
  });

  it("treats an empty text delta as a heartbeat", () => {
    assert.equal(classifyStreamEvent({ kind: "text_delta", hasContent: false }), "heartbeat");
  });

  it("treats heartbeat and usage events as heartbeats", () => {
    assert.equal(classifyStreamEvent({ kind: "heartbeat", hasContent: true }), "heartbeat");
    assert.equal(classifyStreamEvent({ kind: "usage", hasContent: true }), "heartbeat");
    assert.equal(classifyStreamEvent({ kind: "empty_delta", hasContent: false }), "heartbeat");
  });
});
