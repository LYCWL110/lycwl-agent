import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPLETE_SCOPE,
  collectGrepMatches,
  describeCompleteness,
  hasIncompleteScope,
  takeInOrder,
} from "../../src/domain/search/search-facts.ts";

describe("search limit accounting", () => {
  it("does not infer truncation from an exact-length result", () => {
    const outcome = takeInOrder([1, 2, 3], 3);
    assert.deepEqual(outcome.delivered, [1, 2, 3]);
    assert.equal(outcome.observedExtra, 0);
    assert.equal(outcome.limitReached, false);
  });

  it("reports truncation only when an extra item was observed", () => {
    const outcome = takeInOrder([1, 2, 3, 4], 3);
    assert.deepEqual(outcome.delivered, [1, 2, 3]);
    assert.equal(outcome.observedExtra, 1);
    assert.equal(outcome.limitReached, true);
  });
});

describe("grep match accounting", () => {
  it("counts one hit per unique line", () => {
    const result = collectGrepMatches(
      [
        { path: "a.ts", lineNumber: 3, text: "hit" },
        { path: "a.ts", lineNumber: 3, text: "hit" },
        { path: "a.ts", lineNumber: 7, text: "hit" },
      ],
      { limit: 200, contextBefore: 0, contextAfter: 0 },
    );
    assert.equal(result.hitLines, 2);
    assert.deepEqual(
      result.lines.map((line) => line.lineNumber),
      [3, 7],
    );
  });

  it("merges overlapping context windows without adding hits", () => {
    const result = collectGrepMatches(
      [
        { path: "a.ts", lineNumber: 5, text: "hit" },
        { path: "a.ts", lineNumber: 8, text: "hit" },
      ],
      { limit: 200, contextBefore: 2, contextAfter: 2 },
    );
    assert.equal(result.hitLines, 2);
    assert.deepEqual(result.mergedRanges, [{ path: "a.ts", start: 3, end: 10 }]);
  });

  it("keeps separate ranges for distant matches", () => {
    const result = collectGrepMatches(
      [
        { path: "a.ts", lineNumber: 1, text: "hit" },
        { path: "a.ts", lineNumber: 50, text: "hit" },
      ],
      { limit: 200, contextBefore: 1, contextAfter: 1 },
    );
    assert.deepEqual(result.mergedRanges, [
      { path: "a.ts", start: 1, end: 2 },
      { path: "a.ts", start: 49, end: 51 },
    ]);
  });

  it("orders hits by path then line number", () => {
    const result = collectGrepMatches(
      [
        { path: "z.ts", lineNumber: 1, text: "hit" },
        { path: "a.ts", lineNumber: 9, text: "hit" },
        { path: "a.ts", lineNumber: 2, text: "hit" },
      ],
      { limit: 200, contextBefore: 0, contextAfter: 0 },
    );
    assert.deepEqual(
      result.lines.map((line) => `${line.path}:${line.lineNumber}`),
      ["a.ts:2", "a.ts:9", "z.ts:1"],
    );
  });

  it("applies the limit in deterministic order", () => {
    const result = collectGrepMatches(
      [
        { path: "b.ts", lineNumber: 1, text: "hit" },
        { path: "a.ts", lineNumber: 2, text: "hit" },
        { path: "a.ts", lineNumber: 1, text: "hit" },
      ],
      { limit: 2, contextBefore: 0, contextAfter: 0 },
    );
    assert.deepEqual(
      result.lines.map((line) => `${line.path}:${line.lineNumber}`),
      ["a.ts:1", "a.ts:2"],
    );
    assert.equal(result.limitReached, true);
    assert.equal(result.observedExtra, 1);
  });
});

describe("search completeness reporting", () => {
  it("treats a fully searched scope as complete", () => {
    assert.equal(hasIncompleteScope(COMPLETE_SCOPE), false);
    assert.equal(describeCompleteness(COMPLETE_SCOPE), "scope=complete");
  });

  it("distinguishes ignored, skipped and unsearched scopes", () => {
    assert.equal(hasIncompleteScope({ ...COMPLETE_SCOPE, ignoredPaths: ["build/"] }), false);
    assert.equal(hasIncompleteScope({ ...COMPLETE_SCOPE, skippedPaths: ["secret/"] }), true);
    assert.equal(hasIncompleteScope({ ...COMPLETE_SCOPE, unsearchedPaths: ["vendor/"] }), true);
    assert.equal(hasIncompleteScope({ ...COMPLETE_SCOPE, ignoreRulesIncomplete: true }), true);
  });

  it("describes every distinct cause without collapsing them", () => {
    const text = describeCompleteness({
      scopeComplete: false,
      limitReached: true,
      ignoredPaths: ["build/"],
      skippedPaths: ["secret/"],
      unsearchedPaths: ["vendor/"],
      ignoreRulesIncomplete: true,
    });
    assert.equal(
      text,
      "scope=partial; limit=reached; ignored=1; skipped=1; unsearched=1; ignoreRules=incomplete",
    );
  });
});
