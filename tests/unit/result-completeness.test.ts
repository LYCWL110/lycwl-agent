import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPLETE,
  describeCompleteness,
  limitedByPage,
  mergeCompleteness,
  needsContinuation,
  type ResultCompleteness,
  spilledResult,
  truncatedForBudget,
  unconfirmed,
} from "../../src/domain/tool-invocation/result-completeness.ts";

/**
 * Result completeness.
 *
 * The rule these tests protect: completeness is a fact about the result, not a
 * failure. A partial result is still useful, and an unconfirmed one is not a
 * failure at all — the operation may have happened and the Harness simply cannot
 * say. Collapsing those into "failed" would lose information the model needs.
 */

describe("constructors", () => {
  it("marks a budget cut as partial with a continuation", () => {
    const completeness = truncatedForBudget();
    assert.equal(completeness.outcome, "partial");
    assert.equal(completeness.reason, "model_budget");
    // A partial result without a continuation leaves the model unable to proceed.
    assert.notEqual(completeness.continuation, undefined);
  });

  it("marks a page limit as partial", () => {
    const completeness = limitedByPage("Request the next page.");
    assert.equal(completeness.outcome, "partial");
    assert.equal(completeness.reason, "page_limit");
    assert.equal(completeness.continuation, "Request the next page.");
  });

  it("marks a spill as partial and names where the rest is", () => {
    const completeness = spilledResult("spill/abc.txt");
    assert.equal(completeness.outcome, "partial");
    assert.equal(completeness.reason, "spilled");
    assert.match(completeness.continuation ?? "", /spill\/abc\.txt/);
  });

  it("marks an unestablished effect as unconfirmed, not partial", () => {
    // Partial would claim a result arrived; unconfirmed says it could not be
    // established, which is the actual fact.
    const completeness = unconfirmed();
    assert.equal(completeness.outcome, "unconfirmed");
    assert.equal(completeness.reason, "unverified");
  });

  it("exposes a complete value", () => {
    assert.deepEqual(COMPLETE, { outcome: "complete" });
  });
});

describe("needsContinuation", () => {
  it("is false only for a complete result", () => {
    assert.equal(needsContinuation(COMPLETE), false);
    assert.equal(needsContinuation(truncatedForBudget()), true);
    assert.equal(needsContinuation(unconfirmed()), true);
  });
});

describe("describeCompleteness", () => {
  it("says nothing for a complete result", () => {
    // A complete result needs no marker; adding one would be noise on every call.
    assert.equal(describeCompleteness(COMPLETE), null);
  });

  it("marks a budget cut and includes the continuation", () => {
    const text = describeCompleteness(truncatedForBudget());
    assert.match(text ?? "", /^\[partial: cut to fit the token budget\]/);
    assert.match(text ?? "", /read_file/i);
  });

  it("distinguishes unconfirmed from partial", () => {
    // The two must not read the same: one means "there is more", the other means
    // "nobody knows".
    const partial = describeCompleteness(truncatedForBudget());
    const unknown = describeCompleteness(unconfirmed());
    assert.notEqual(partial, unknown);
    assert.match(unknown ?? "", /^\[unconfirmed:/);
  });

  it("names the spill reason", () => {
    assert.match(describeCompleteness(spilledResult("x")) ?? "", /stored in full/);
  });

  it("omits the continuation line when there is none", () => {
    const text = describeCompleteness({ outcome: "partial", reason: "page_limit" });
    assert.equal(text?.includes("\n"), false);
  });
});

describe("mergeCompleteness", () => {
  it("keeps the more severe outcome", () => {
    // An unconfirmed result stays unconfirmed even if a later stage would mark it
    // partial: the unknown is the stronger statement.
    const merged = mergeCompleteness(unconfirmed(), truncatedForBudget());
    assert.equal(merged.outcome, "unconfirmed");
  });

  it("keeps unconfirmed on the right as well", () => {
    assert.equal(mergeCompleteness(truncatedForBudget(), unconfirmed()).outcome, "unconfirmed");
  });

  it("keeps the first partial reason", () => {
    // The first reason is the one that caused the cut.
    const merged = mergeCompleteness(limitedByPage("next"), spilledResult("x"));
    assert.equal(merged.reason, "page_limit");
  });

  it("returns the non-complete side when one is complete", () => {
    assert.equal(mergeCompleteness(COMPLETE, truncatedForBudget()).outcome, "partial");
    assert.equal(mergeCompleteness(truncatedForBudget(), COMPLETE).outcome, "partial");
  });

  it("is complete only when both are complete", () => {
    assert.equal(mergeCompleteness(COMPLETE, COMPLETE).outcome, "complete");
  });
});

describe("every outcome is distinguishable", () => {
  it("produces a distinct marker for each non-complete outcome", () => {
    const markers = new Set<string | null>([
      describeCompleteness(COMPLETE),
      describeCompleteness(truncatedForBudget()),
      describeCompleteness(unconfirmed()),
    ]);
    // Three outcomes, three distinct renderings.
    assert.equal(markers.size, 3);
  });

  it("keeps reason codes within the declared set", () => {
    const allowed = new Set(["model_budget", "page_limit", "spilled", "unverified"]);
    const all: ResultCompleteness[] = [
      truncatedForBudget(),
      limitedByPage("x"),
      spilledResult("x"),
      unconfirmed(),
    ];
    for (const completeness of all) {
      if (completeness.reason === undefined) continue;
      assert.equal(allowed.has(completeness.reason), true, completeness.reason);
    }
  });
});
