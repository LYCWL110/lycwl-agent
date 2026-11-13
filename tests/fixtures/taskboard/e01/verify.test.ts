import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChunkArgumentError, splitIntoChunks } from "./src/chunks.ts";

/**
 * Independent verifier for evaluation case E01.
 *
 * This file is held by the grader and is never shown to the model. It asserts the
 * behaviour the task requires, independent of the implementation's shape: any fix
 * that produces these results passes, and no fix that only satisfies the public
 * test does.
 *
 * The negative controls below run against deliberately wrong implementations. They
 * exist so that "the verifier passes" cannot be satisfied by a verifier that
 * accepts anything.
 */

describe("E01 FAIL_TO_PASS: the divisible case", () => {
  it("keeps a final chunk that is exactly the requested size", () => {
    // The defect: this returned [[1,2]] and dropped [3,4].
    assert.deepEqual(splitIntoChunks([1, 2, 3, 4], 2), [
      [1, 2],
      [3, 4],
    ]);
  });

  it("keeps every element when the length is a multiple of size", () => {
    assert.deepEqual(splitIntoChunks([1, 2, 3, 4, 5, 6], 3), [
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });
});

describe("E01 PASS_TO_PASS: behaviour that must not change", () => {
  it("splits a non-divisible list", () => {
    assert.deepEqual(splitIntoChunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("returns an empty list for empty input", () => {
    assert.deepEqual(splitIntoChunks([], 3), []);
  });

  it("puts each item in its own chunk when size is 1", () => {
    assert.deepEqual(splitIntoChunks([1, 2, 3], 1), [[1], [2], [3]]);
  });

  it("keeps every element when size exceeds the length", () => {
    assert.deepEqual(splitIntoChunks([1, 2], 5), [[1, 2]]);
  });

  it("preserves input order", () => {
    const values = ["c", "a", "b"];
    assert.deepEqual(splitIntoChunks(values, 2), [["c", "a"], ["b"]]);
  });

  it("does not modify the input array", () => {
    const values = [1, 2, 3, 4];
    const snapshot = [...values];
    splitIntoChunks(values, 2);
    assert.deepEqual(values, snapshot);
  });
});

describe("E01 argument validation", () => {
  it("rejects zero", () => {
    assert.throws(() => splitIntoChunks([1], 0), ChunkArgumentError);
  });

  it("rejects a negative size", () => {
    assert.throws(() => splitIntoChunks([1], -1), ChunkArgumentError);
  });

  it("rejects a non-integer size", () => {
    assert.throws(() => splitIntoChunks([1], 1.5), ChunkArgumentError);
  });
});

/**
 * Negative controls.
 *
 * Each is a wrong implementation. The verifier's assertions are applied to them and
 * must fail, which proves the assertions actually discriminate rather than passing
 * on anything.
 */
const WRONG_IMPLEMENTATIONS: Readonly<
  Record<string, (values: readonly unknown[], size: number) => unknown[][]>
> = {
  "original defect: drops a full final chunk": (values, size) => {
    const chunks: unknown[][] = [];
    for (let index = 0; index < values.length; index += size) {
      const chunk = values.slice(index, index + size);
      if (chunk.length < size) chunks.push(chunk);
    }
    return chunks;
  },
  "only fixes the public example": (values, size) => {
    // Returns the expected result for the one case the public test covers and the
    // defect for everything else.
    if (size === 2 && values.length === 5) return [[1, 2], [3, 4], [5]];
    const chunks: unknown[][] = [];
    for (let index = 0; index < values.length; index += size) {
      const chunk = values.slice(index, index + size);
      if (chunk.length < size) chunks.push(chunk);
    }
    return chunks;
  },
  "drops the tail instead": (values, size) => {
    const chunks: unknown[][] = [];
    for (let index = 0; index + size <= values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  },
  "mutates the input": (values, size) => {
    const mutable = values as unknown[];
    const chunks: unknown[][] = [];
    while (mutable.length > 0) chunks.push(mutable.splice(0, size));
    return chunks;
  },
};

describe("E01 negative controls", () => {
  const reference = (values: readonly unknown[], size: number): unknown[][] => {
    const chunks: unknown[][] = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  };

  it("the reference implementation satisfies every assertion", () => {
    // A positive control: the assertions are satisfiable.
    assert.deepEqual(reference([1, 2, 3, 4], 2), [
      [1, 2],
      [3, 4],
    ]);
    assert.deepEqual(reference([], 3), []);
    assert.deepEqual(reference([1, 2, 3], 1), [[1], [2], [3]]);
    assert.deepEqual(reference([1, 2], 5), [[1, 2]]);
  });

  /**
   * Run the full assertion set against an implementation.
   *
   * A single case is not enough: "drops the tail" and "mutates the input" both
   * produce the correct result for [1,2,3,4] size 2, so only the whole set
   * discriminates them.
   */
  const passesAllAssertions = (
    implementation: (values: readonly unknown[], size: number) => unknown[][],
  ): boolean => {
    try {
      const cases: readonly (readonly [readonly unknown[], number])[] = [
        [[1, 2, 3, 4], 2],
        [[1, 2, 3, 4, 5, 6], 3],
        [[1, 2, 3, 4, 5], 2],
        [[], 3],
        [[1, 2, 3], 1],
        [[1, 2], 5],
      ];
      for (const [values, size] of cases) {
        const input = [...values];
        const produced = implementation(input, size);
        assert.deepEqual(produced, reference(values, size));
        // The input must be untouched.
        assert.deepEqual(input, [...values]);
      }
      return true;
    } catch {
      return false;
    }
  };

  it("the reference implementation passes the full set", () => {
    assert.equal(passesAllAssertions(reference), true);
  });

  for (const [name, wrong] of Object.entries(WRONG_IMPLEMENTATIONS)) {
    it(`rejects: ${name}`, () => {
      assert.equal(passesAllAssertions(wrong), false, name);
    });
  }
});
