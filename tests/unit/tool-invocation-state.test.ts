import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  receiveToolInvocation,
  transitionToolInvocation,
} from "../../src/domain/tool-invocation/tool-invocation-state.ts";

describe("tool invocation state machine", () => {
  it("requires validation before approval", () => {
    const received = receiveToolInvocation("call-1");
    assert.equal(received.ok, true);
    if (!received.ok) return;
    assert.deepEqual(transitionToolInvocation(received.value, "awaiting_approval"), {
      ok: false,
      code: "invalid_transition",
    });
  });

  it("keeps terminal outcomes immutable", () => {
    const received = receiveToolInvocation("call-1");
    assert.equal(received.ok, true);
    if (!received.ok) return;
    const validated = transitionToolInvocation(received.value, "validated");
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const ready = transitionToolInvocation(validated.value, "ready");
    assert.equal(ready.ok, true);
    if (!ready.ok) return;
    const executing = transitionToolInvocation(ready.value, "executing");
    assert.equal(executing.ok, true);
    if (!executing.ok) return;
    const unknown = transitionToolInvocation(executing.value, "outcome_unknown");
    assert.equal(unknown.ok, true);
    if (!unknown.ok) return;
    assert.deepEqual(transitionToolInvocation(unknown.value, "succeeded"), {
      ok: false,
      code: "terminal_outcome_immutable",
    });
  });
});
