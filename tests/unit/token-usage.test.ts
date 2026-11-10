import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addUsage,
  describeUsage,
  estimateCostUsd,
  parseAnthropicUsage,
  parseOpenAiChatUsage,
  parseOpenAiResponsesUsage,
} from "../../src/domain/model-request/token-usage.ts";

/**
 * Usage normalization.
 *
 * The three protocols report the same facts under different names and each omits
 * a different subset. The rule these tests enforce is that a missing count stays
 * absent: turning it into zero would make an unpriced request look free.
 */

describe("parseAnthropicUsage", () => {
  it("reads input and output", () => {
    assert.deepEqual(parseAnthropicUsage({ usage: { input_tokens: 120, output_tokens: 30 } }), {
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("adds cache reads and writes to the prompt size", () => {
    // Anthropic reports cache tokens outside `input_tokens`, so the real prompt is
    // the sum. Using input_tokens alone understates a long Session by the whole
    // cached prefix, which is the part caching exists for.
    assert.deepEqual(
      parseAnthropicUsage({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 90,
        },
      }),
      { inputTokens: 1_000, outputTokens: 5, cachedInputTokens: 990 },
    );
  });

  it("returns undefined when there is no usage object", () => {
    assert.equal(parseAnthropicUsage({}), undefined);
  });

  it("ignores non-integer and negative counts", () => {
    assert.deepEqual(
      parseAnthropicUsage({ usage: { input_tokens: 1.5, output_tokens: -3 } }),
      undefined,
    );
  });

  it("ignores a string count", () => {
    assert.deepEqual(parseAnthropicUsage({ usage: { input_tokens: "120" } }), undefined);
  });
});

describe("parseOpenAiChatUsage", () => {
  it("reads prompt and completion tokens", () => {
    assert.deepEqual(
      parseOpenAiChatUsage({ usage: { prompt_tokens: 200, completion_tokens: 40 } }),
      { inputTokens: 200, outputTokens: 40 },
    );
  });

  it("does not add cached tokens, which are already inside prompt_tokens", () => {
    // Adding these would double-count. This is the opposite of Anthropic's shape
    // and is exactly why the two parsers are separate.
    assert.deepEqual(
      parseOpenAiChatUsage({
        usage: {
          prompt_tokens: 200,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 150 },
        },
      }),
      { inputTokens: 200, outputTokens: 40, cachedInputTokens: 150 },
    );
  });

  it("reads reasoning tokens", () => {
    assert.deepEqual(
      parseOpenAiChatUsage({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      }),
      { inputTokens: 10, outputTokens: 20, reasoningTokens: 8 },
    );
  });

  it("returns undefined without a usage object", () => {
    assert.equal(parseOpenAiChatUsage({ choices: [] }), undefined);
  });
});

describe("parseOpenAiResponsesUsage", () => {
  it("reads input and output", () => {
    assert.deepEqual(
      parseOpenAiResponsesUsage({ usage: { input_tokens: 300, output_tokens: 60 } }),
      { inputTokens: 300, outputTokens: 60 },
    );
  });

  it("does not add cached input, which is a subset", () => {
    assert.deepEqual(
      parseOpenAiResponsesUsage({
        usage: {
          input_tokens: 300,
          output_tokens: 60,
          input_tokens_details: { cached_tokens: 250 },
        },
      }),
      { inputTokens: 300, outputTokens: 60, cachedInputTokens: 250 },
    );
  });

  it("reads reasoning from the output details", () => {
    assert.deepEqual(
      parseOpenAiResponsesUsage({
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      }),
      { inputTokens: 1, outputTokens: 2, reasoningTokens: 1 },
    );
  });
});

describe("addUsage", () => {
  it("returns the other side when one is undefined", () => {
    const usage = { inputTokens: 1, outputTokens: 2 };
    assert.deepEqual(addUsage(undefined, usage), usage);
    assert.deepEqual(addUsage(usage, undefined), usage);
  });

  it("returns undefined when both are undefined", () => {
    assert.equal(addUsage(undefined, undefined), undefined);
  });

  it("sums both sides", () => {
    assert.deepEqual(
      addUsage({ inputTokens: 10, outputTokens: 2 }, { inputTokens: 5, outputTokens: 3 }),
      { inputTokens: 15, outputTokens: 5 },
    );
  });

  it("keeps an optional field that only one side reported", () => {
    // One request reported a cached prefix and the other did not. The total keeps
    // the known figure rather than dropping it or treating the missing one as zero
    // in a way that would change the reported number.
    assert.deepEqual(
      addUsage(
        { inputTokens: 10, outputTokens: 1, cachedInputTokens: 8 },
        { inputTokens: 10, outputTokens: 1 },
      ),
      { inputTokens: 20, outputTokens: 2, cachedInputTokens: 8 },
    );
  });
});

describe("estimateCostUsd", () => {
  const price = { inputPerMillion: 3, outputPerMillion: 15 };

  it("computes a cost from a known price", () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price);
    assert.equal(cost, 18);
  });

  it("returns null when the price is unknown", () => {
    // A null is reported as unknown spending, not as zero.
    assert.equal(estimateCostUsd({ inputTokens: 100, outputTokens: 100 }, null), null);
  });

  it("returns null when the usage is unknown", () => {
    assert.equal(estimateCostUsd(undefined, price), null);
  });

  it("returns null for a nonsensical price instead of a negative cost", () => {
    assert.equal(
      estimateCostUsd(
        { inputTokens: 10, outputTokens: 10 },
        { inputPerMillion: -1, outputPerMillion: 1 },
      ),
      null,
    );
  });

  it("does not charge cached tokens at the full rate as a separate item", () => {
    // The cached count is a subset of inputTokens, so billing it again would
    // overcharge. The cost depends only on the two primary counts.
    const withCache = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      price,
    );
    assert.equal(withCache, 3);
  });
});

describe("describeUsage", () => {
  it("says unknown rather than zero", () => {
    assert.equal(describeUsage(undefined), "tokens unknown");
  });

  it("lists the counts", () => {
    assert.equal(
      describeUsage({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, reasoningTokens: 1 }),
      "in 10 / out 2 / cached 8 / reasoning 1",
    );
  });

  it("omits the optional parts when absent", () => {
    assert.equal(describeUsage({ inputTokens: 10, outputTokens: 2 }), "in 10 / out 2");
  });
});
