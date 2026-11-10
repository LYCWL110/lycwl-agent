import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEntityId } from "../../src/domain/identity/id.ts";

describe("identifier boundary", () => {
  it("accepts 1-128 printable ASCII characters", () => {
    assert.equal(parseEntityId("session_01"), "session_01");
    assert.equal(parseEntityId("x".repeat(128)), "x".repeat(128));
  });

  it("rejects empty, spaced, non-ASCII, and overlong values", () => {
    assert.throws(() => parseEntityId(""));
    assert.throws(() => parseEntityId("has space"));
    assert.throws(() => parseEntityId("标识符"));
    assert.throws(() => parseEntityId("x".repeat(129)));
  });
});
