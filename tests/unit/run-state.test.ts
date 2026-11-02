import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  finishRun,
  isTerminalRun,
  resolveRunWait,
  resumeRun,
  startRun,
  waitRun,
} from "../../src/domain/run/run-state.ts";

describe("Run state machine", () => {
  it("waits and resolves only the matching blocker", () => {
    const active = startRun();
    const waiting = waitRun(active, "approval", "wait-1", 1);
    assert.equal(waiting.ok, true);
    if (!waiting.ok) return;

    const wrong = resolveRunWait(waiting.value, {
      reason: "approval",
      waitToken: "wait-2",
      requestVersion: 1,
    });
    assert.deepEqual(wrong, { ok: false, code: "wait_not_resolvable" });

    const resolved = resolveRunWait(waiting.value, {
      reason: "approval",
      waitToken: "wait-1",
      requestVersion: 1,
    });
    assert.deepEqual(resolved, { ok: true, value: { state: "active" } });
  });

  it("requires explicit resume for configuration and recovery waits", () => {
    const waiting = waitRun(startRun(), "configuration", "wait-1", 1);
    assert.equal(waiting.ok, true);
    if (!waiting.ok) return;
    assert.deepEqual(resumeRun(waiting.value), { ok: true, value: { state: "active" } });
  });

  it("never revives a terminal Run", () => {
    const completed = finishRun(startRun(), "completed");
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    assert.equal(isTerminalRun(completed.value), true);
    assert.deepEqual(resumeRun(completed.value), { ok: false, code: "run_terminal" });
    assert.deepEqual(waitRun(completed.value, "approval", "wait-1", 1), {
      ok: false,
      code: "run_terminal",
    });
  });

  it("rejects malformed wait identity", () => {
    assert.deepEqual(waitRun(startRun(), "approval", "", 1), {
      ok: false,
      code: "invalid_wait",
    });
    assert.deepEqual(waitRun(startRun(), "approval", "wait-1", 0), {
      ok: false,
      code: "invalid_wait",
    });
  });
});
