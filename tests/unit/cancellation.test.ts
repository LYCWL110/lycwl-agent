import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareCancellation, projectCancelledCall } from "../../src/domain/run/cancellation.ts";

describe("cancellation and dispatch ordering", () => {
  it("prevents a dispatch accepted after cancellation", () => {
    assert.deepEqual(compareCancellation({ cancelSeq: 5, dispatchSeq: 6 }), {
      ok: true,
      outcome: "dispatch_prevented",
    });
  });

  it("does not undo a dispatch committed before cancellation", () => {
    assert.deepEqual(compareCancellation({ cancelSeq: 7, dispatchSeq: 6 }), {
      ok: true,
      outcome: "dispatch_already_committed",
    });
  });

  it("treats a same-sequence race as already committed", () => {
    assert.deepEqual(compareCancellation({ cancelSeq: 6, dispatchSeq: 6 }), {
      ok: true,
      outcome: "dispatch_already_committed",
    });
  });

  it("rejects non-positive or non-integer sequences", () => {
    assert.deepEqual(compareCancellation({ cancelSeq: 0, dispatchSeq: 3 }), {
      ok: false,
      code: "invalid_sequence",
    });
    assert.deepEqual(compareCancellation({ cancelSeq: 1.5, dispatchSeq: 3 }), {
      ok: false,
      code: "invalid_sequence",
    });
  });
});

describe("cancelled call projection", () => {
  it("cancels a call that never started without claiming an effect", () => {
    assert.deepEqual(projectCancelledCall({ toolCallId: "call-1", sideEffect: "not_started" }), {
      toolCallId: "call-1",
      outcome: "cancelled",
      safeCode: null,
    });
  });

  it("reports an in-flight cancellation as an unknown outcome", () => {
    assert.deepEqual(projectCancelledCall({ toolCallId: "call-1", sideEffect: "in_flight" }), {
      toolCallId: "call-1",
      outcome: "cancelled_outcome_unknown",
      safeCode: "cancelled_during_execution",
    });
  });

  it("preserves a side effect that completed before cancellation", () => {
    assert.deepEqual(projectCancelledCall({ toolCallId: "call-1", sideEffect: "completed" }), {
      toolCallId: "call-1",
      outcome: "completed_before_cancel",
      safeCode: null,
    });
  });
});
