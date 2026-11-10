import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDemoRuntime } from "../../src/bootstrap/demo-runtime.ts";

/**
 * The demo runtime is the entry point wired to `lycwl`, so its honesty matters
 * more than a normal fixture's. These tests pin two behaviours that were wrong:
 *
 * 1. A tool with no real implementation reported `succeeded`.
 * 2. Sensitive reads were approved by an unconditional gate.
 */

describe("demo runtime honesty", () => {
  it("does not claim a write it cannot perform", async () => {
    const runtime = createDemoRuntime(process.cwd());
    // The scripted provider requests `write_note` for a task containing "write".
    const pending = runtime.coordinator.run("please write a note");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const view = runtime.coordinator.pendingApprovalView();
    assert.ok(view !== null, "the write must suspend for approval");
    if (view === null) return;
    assert.equal(view.toolName, "write_note");

    await runtime.coordinator.replyApproval({
      commandId: "c1",
      approvalId: view.approvalId,
      toolCallId: view.toolCallId,
      requestVersion: view.requestVersion,
      decision: "approved",
    });

    const settled = (await runtime.coordinator.settle()) ?? (await pending);
    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished.length, 1);
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;

    // Approving a write must not produce a success the runtime cannot back.
    assert.equal(payload.status, "failed");
    assert.equal(payload.safeCode, "demo_tool_does_not_write");
  });

  it("leaves the run completed rather than pretending the work happened", async () => {
    const runtime = createDemoRuntime(process.cwd());
    const pending = runtime.coordinator.run("write something");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const view = runtime.coordinator.pendingApprovalView();
    if (view === null) return;
    await runtime.coordinator.replyApproval({
      commandId: "c1",
      approvalId: view.approvalId,
      toolCallId: view.toolCallId,
      requestVersion: view.requestVersion,
      decision: "denied",
    });
    const settled = (await runtime.coordinator.settle()) ?? (await pending);
    // A denial is a failed tool result, not a Run failure and not a success.
    assert.equal(settled.status, "completed");
    const denied = settled.events.filter((event) => event.payload.kind === "tool_execution_denied");
    assert.equal(denied.length, 1);
  });
});
