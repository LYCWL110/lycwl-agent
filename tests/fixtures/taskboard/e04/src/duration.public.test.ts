import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDurationMs } from "./duration.ts";

/**
 * The existing public test for `parseDurationMs`.
 *
 * It covers a few normal inputs only. The task for E04 is to add boundary and error
 * tests that discriminate: they must pass here and fail against planted defects.
 *
 * The model may read and extend this file. It may not change the product behaviour
 * to make new tests pass.
 */

describe("parseDurationMs (existing coverage)", () => {
  it("parses milliseconds", () => {
    assert.equal(parseDurationMs("250ms"), 250);
  });

  it("parses seconds", () => {
    assert.equal(parseDurationMs("2s"), 2000);
  });
});
