import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginModelRequest,
  finishModelRequest,
} from "../../src/domain/model-request/model-request-state.ts";

describe("model request state machine", () => {
  it("accepts only a complete terminal transition", () => {
    const started = beginModelRequest("request-1", 1);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const finished = finishModelRequest(started.value, "succeeded");
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    assert.deepEqual(finishModelRequest(finished.value, "failed"), {
      ok: false,
      code: "invalid_transition",
    });
  });

  it("uses positive attempt numbers", () => {
    assert.deepEqual(beginModelRequest("request-1", 0), {
      ok: false,
      code: "invalid_request_identity",
    });
  });
});
