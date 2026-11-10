import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeMeter,
  estimateConversationTokens,
  readContextMeter,
} from "../../src/domain/context/context-meter.ts";

/**
 * Context occupancy.
 *
 * The rule these tests protect: a number must never be presented more confidently
 * than its source allows. A provider count is authoritative; a local estimate is
 * labelled as such; an unknown window shows a raw count rather than a fabricated
 * percentage.
 */

describe("estimateConversationTokens", () => {
  it("counts an empty conversation as zero", () => {
    assert.equal(estimateConversationTokens([]), 0);
  });

  it("counts text at four characters per token plus overhead", () => {
    const tokens = estimateConversationTokens([{ kind: "user", text: "x".repeat(400) }]);
    // 400 / 4 = 100, plus per-message overhead.
    assert.ok(tokens >= 100 && tokens < 110, `got ${tokens}`);
  });

  it("counts tool call names and arguments", () => {
    const withCall = estimateConversationTokens([
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ toolName: "read_file", arguments: { path: "a".repeat(400) } }],
      },
    ]);
    const withoutCall = estimateConversationTokens([
      { kind: "assistant", text: null, toolCalls: [] },
    ]);
    assert.ok(withCall > withoutCall);
  });

  it("counts tool results", () => {
    const tokens = estimateConversationTokens([{ kind: "tool_result", text: "y".repeat(4_000) }]);
    assert.ok(tokens >= 1_000, `got ${tokens}`);
  });

  it("treats a null text as empty rather than crashing", () => {
    assert.doesNotThrow(() => estimateConversationTokens([{ kind: "tool_result", text: null }]));
  });
});

describe("readContextMeter", () => {
  const conversation = [{ kind: "user", text: "x".repeat(4_000) }] as const;

  it("labels an estimate when no provider count exists", () => {
    const meter = readContextMeter({
      conversation,
      measuredInputTokens: null,
      window: 100_000,
      compactionTrigger: null,
      fixedTokens: 0,
    });
    assert.equal(meter.source, "estimated");
    assert.ok(meter.used >= 1_000);
  });

  it("prefers the provider count when it exists", () => {
    const meter = readContextMeter({
      conversation,
      measuredInputTokens: 42_000,
      window: 100_000,
      compactionTrigger: null,
      fixedTokens: 0,
    });
    assert.equal(meter.source, "measured");
    assert.equal(meter.used, 42_000);
    assert.equal(meter.fraction, 0.42);
  });

  it("adds the fixed overhead to both sources", () => {
    const meter = readContextMeter({
      conversation: [],
      measuredInputTokens: 1_000,
      window: 10_000,
      compactionTrigger: null,
      fixedTokens: 500,
    });
    assert.equal(meter.used, 1_500);
  });

  it("reports a null fraction when the window is unknown", () => {
    // A percentage without a denominator would be invented.
    const meter = readContextMeter({
      conversation,
      measuredInputTokens: 5_000,
      window: null,
      compactionTrigger: null,
      fixedTokens: 0,
    });
    assert.equal(meter.fraction, null);
    assert.equal(meter.window, null);
    assert.equal(meter.used, 5_000);
  });

  it("clamps the fraction to one", () => {
    const meter = readContextMeter({
      conversation: [],
      measuredInputTokens: 500_000,
      window: 100_000,
      compactionTrigger: null,
      fixedTokens: 0,
    });
    assert.equal(meter.fraction, 1);
  });

  it("flags the compaction trigger", () => {
    const meter = readContextMeter({
      conversation: [],
      measuredInputTokens: 80_000,
      window: 100_000,
      compactionTrigger: 75_000,
      fixedTokens: 0,
    });
    assert.equal(meter.atCompaction, true);
  });

  it("does not flag the trigger below it", () => {
    const meter = readContextMeter({
      conversation: [],
      measuredInputTokens: 50_000,
      window: 100_000,
      compactionTrigger: 75_000,
      fixedTokens: 0,
    });
    assert.equal(meter.atCompaction, false);
  });
});

describe("describeMeter", () => {
  it("returns null when there is no meter", () => {
    assert.equal(describeMeter(null), null);
  });

  it("returns null for zero usage", () => {
    assert.equal(
      describeMeter({
        used: 0,
        window: 100_000,
        fraction: 0,
        source: "estimated",
        compactionTrigger: null,
        atCompaction: false,
      }),
      null,
    );
  });

  it("shows a percentage when the window is known", () => {
    assert.equal(
      describeMeter({
        used: 42_000,
        window: 100_000,
        fraction: 0.42,
        source: "measured",
        compactionTrigger: null,
        atCompaction: false,
      }),
      "ctx 42%",
    );
  });

  it("marks a Run at the compaction trigger", () => {
    assert.equal(
      describeMeter({
        used: 80_000,
        window: 100_000,
        fraction: 0.8,
        source: "measured",
        compactionTrigger: 75_000,
        atCompaction: true,
      }),
      "ctx 80% !",
    );
  });

  it("shows a raw count when the window is unknown", () => {
    assert.equal(
      describeMeter({
        used: 12_500,
        window: null,
        fraction: null,
        source: "estimated",
        compactionTrigger: null,
        atCompaction: false,
      }),
      "ctx 12.5k",
    );
  });
});
