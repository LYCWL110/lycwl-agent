import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitIntoChunks } from "./chunks.ts";

/**
 * Public test for the `splitIntoChunks` fixture.
 *
 * It covers only the non-divisible case, which is why the defect in the
 * implementation is not caught here. This is deliberate: the evaluation measures
 * whether a fix also handles the divisible case, and a public test that already
 * covered it would give the answer away.
 *
 * The model may read and run this test. It may not edit it to pass.
 */

describe("splitIntoChunks", () => {
  it("splits a list that does not divide evenly", () => {
    assert.deepEqual(splitIntoChunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("rejects a non-positive size", () => {
    assert.throws(() => splitIntoChunks([1], 0));
  });
});
