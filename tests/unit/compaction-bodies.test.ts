import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareCompaction } from "../../src/application/coordinator/compaction-service.ts";
import type { ProviderConversationItem } from "../../src/ports/model-provider.ts";

/**
 * `full` representation must carry the actual body text.
 *
 * ADR-0046 recorded a defect: the summarisation prompt rendered member ids instead
 * of text, so `full` was a lie — the summariser was told a group was fully
 * available while receiving only identities. These tests pin the corrected
 * behaviour, and the excerpt marker that keeps a clipped body from being mistaken
 * for a complete one.
 */

const LONG_BODY = "HEAD".repeat(200) + "MIDDLE" + "TAIL".repeat(200);

function conversationWithLongBody(): readonly ProviderConversationItem[] {
  return [
    { kind: "user", text: "please inspect the file" },
    {
      kind: "assistant",
      text: "reading it",
      toolCalls: [{ providerToolCallId: "c1", toolName: "read_file", arguments: { path: "a.ts" } }],
    },
    {
      kind: "tool_result",
      providerToolCallId: "c1",
      toolName: "read_file",
      status: "succeeded",
      text: LONG_BODY,
    },
    { kind: "user", text: "thanks" },
  ];
}

/** A plan that summarises everything: recentBudget 0 pushes all groups out of the suffix. */
function preparation() {
  const prepared = prepareCompaction({
    conversation: conversationWithLongBody(),
    fixedTokens: 0,
    // Large enough that every body fits as `full`.
    auxiliaryBudgetTokens: 1_000_000,
    recentBudget: 0,
    compactionsUsed: 0,
  });
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
  if (!prepared.ok) throw new Error("prepare");
  return prepared.value;
}

describe("full representation carries body text", () => {
  it("includes the tool result text, not just its id", () => {
    const prepared = preparation();
    // Every group fits, so all are `full`.
    for (const skeleton of prepared.plan.skeletons) {
      assert.equal(skeleton.representation, "full");
    }
    assert.ok(prepared.prompt.includes("HEAD"), "the body must be present");
    assert.ok(prepared.prompt.includes("MIDDLE"));
    assert.ok(prepared.prompt.includes("TAIL"));
    // The id still appears, because the pair has to stay identifiable.
    assert.ok(prepared.prompt.includes("tool_result:c1"));
    assert.ok(prepared.prompt.includes("read_file"));
  });

  it("includes assistant text", () => {
    const prepared = preparation();
    assert.ok(prepared.prompt.includes("reading it"));
  });

  it("includes user text", () => {
    const prepared = preparation();
    assert.ok(prepared.prompt.includes("please inspect the file"));
  });

  it("never marks a full body as truncated", () => {
    const prepared = preparation();
    assert.equal(prepared.prompt.includes("[truncated"), false);
  });
});

describe("excerpt representation is bounded and marked", () => {
  it("clips a body that does not fit and says so", () => {
    // A budget that fits the skeletons and only excerpts of the bodies.
    const prepared = prepareCompaction({
      conversation: conversationWithLongBody(),
      fixedTokens: 0,
      auxiliaryBudgetTokens: 600,
      recentBudget: 0,
      compactionsUsed: 0,
    });
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
    if (!prepared.ok) return;

    const representations = prepared.value.plan.skeletons.map((s) => s.representation);
    assert.ok(
      representations.includes("excerpt") || representations.includes("reference_only"),
      `expected a degraded representation, got ${representations.join(",")}`,
    );

    if (representations.includes("excerpt")) {
      assert.ok(prepared.value.prompt.includes("[truncated"), "an excerpt must be marked");
      // The middle of the body must not be presented as if the whole were included.
      assert.equal(prepared.value.prompt.includes("MIDDLE"), false);
    }
    if (representations.includes("reference_only")) {
      // A reference-only group contributes no body at all.
      const skeletonOnly =
        prepared.value.prompt.includes("HEAD") && prepared.value.prompt.includes("MIDDLE");
      assert.equal(skeletonOnly, false);
    }
  });

  it("refuses a window too small for the rendered instructions and skeleton", () => {
    const prepared = prepareCompaction({
      conversation: conversationWithLongBody(),
      fixedTokens: 0,
      auxiliaryBudgetTokens: 120,
      recentBudget: 0,
      compactionsUsed: 0,
    });
    assert.ok(!prepared.ok && prepared.reason === "capacity_insufficient");
  });
});
