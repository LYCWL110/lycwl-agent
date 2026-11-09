import type { TokenUsage } from "../../ports/model-provider.ts";

/**
 * Token usage extraction for the three protocols.
 *
 * The three providers report the same facts under different names, and each
 * reports a different subset. This module normalizes them without inventing
 * values: a count the provider did not send stays absent, because a missing count
 * means the cost is unknown, not free.
 *
 * Every field is read defensively. A provider that sends a string, a negative
 * number or a float must not produce a usage figure that later looks authoritative.
 */

function readCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  // Providers report integers; a float would be a schema error worth ignoring
  // rather than rounding into a plausible-looking number.
  if (!Number.isInteger(value)) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Anthropic Messages: `usage.input_tokens` / `output_tokens`, plus
 * `cache_read_input_tokens` for the cached prefix.
 *
 * Anthropic counts cache reads separately from `input_tokens`, so the total prompt
 * size is the sum. `input_tokens` alone would understate the context by the size
 * of the cached prefix, which is exactly the part a long Session relies on.
 */
export function parseAnthropicUsage(body: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(body["usage"]);
  if (usage === null) return undefined;
  const input = readCount(usage, "input_tokens");
  const output = readCount(usage, "output_tokens");
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = readCount(usage, "cache_read_input_tokens");
  const cacheWrite = readCount(usage, "cache_creation_input_tokens");
  const cached =
    cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens: (input ?? 0) + (cached ?? 0),
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/**
 * OpenAI Chat Completions: `usage.prompt_tokens` / `completion_tokens`.
 *
 * `prompt_tokens` already includes the cached prefix, so it is used as-is;
 * `prompt_tokens_details.cached_tokens` is a subset and is recorded separately for
 * display, never added.
 */
export function parseOpenAiChatUsage(body: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(body["usage"]);
  if (usage === null) return undefined;
  const input = readCount(usage, "prompt_tokens");
  const output = readCount(usage, "completion_tokens");
  if (input === undefined && output === undefined) return undefined;

  const promptDetails = asRecord(usage["prompt_tokens_details"]);
  const cached = promptDetails === null ? undefined : readCount(promptDetails, "cached_tokens");
  const completionDetails = asRecord(usage["completion_tokens_details"]);
  const reasoning =
    completionDetails === null ? undefined : readCount(completionDetails, "reasoning_tokens");

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/**
 * OpenAI Responses: `usage.input_tokens` / `output_tokens`.
 *
 * `input_tokens` already includes cached tokens; `input_tokens_details.cached_tokens`
 * is a subset and is recorded, not added.
 */
export function parseOpenAiResponsesUsage(body: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(body["usage"]);
  if (usage === null) return undefined;
  const input = readCount(usage, "input_tokens");
  const output = readCount(usage, "output_tokens");
  if (input === undefined && output === undefined) return undefined;

  const inputDetails = asRecord(usage["input_tokens_details"]);
  const cached = inputDetails === null ? undefined : readCount(inputDetails, "cached_tokens");
  const outputDetails = asRecord(usage["output_tokens_details"]);
  const reasoning =
    outputDetails === null ? undefined : readCount(outputDetails, "reasoning_tokens");

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/** Add two usage figures, treating an absent count as zero for the sum only. */
export function addUsage(
  total: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (next === undefined) return total;
  if (total === undefined) return next;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...sumOptional("cachedInputTokens", total.cachedInputTokens, next.cachedInputTokens),
    ...sumOptional("reasoningTokens", total.reasoningTokens, next.reasoningTokens),
  };
}

function sumOptional(
  key: "cachedInputTokens" | "reasoningTokens",
  left: number | undefined,
  right: number | undefined,
): Record<string, number> {
  if (left === undefined && right === undefined) return {};
  return { [key]: (left ?? 0) + (right ?? 0) };
}

/**
 * Cost in USD when both a usage figure and a price are known.
 *
 * Returns null when either side is unknown. The Run budget treats a null as
 * unknown spending, which is not the same as zero: a Run with unpriced requests
 * must not appear to have cost nothing.
 */
export function estimateCostUsd(
  usage: TokenUsage | undefined,
  price: Readonly<{ inputPerMillion: number; outputPerMillion: number }> | null,
): number | null {
  if (usage === undefined || price === null) return null;
  if (!Number.isFinite(price.inputPerMillion) || !Number.isFinite(price.outputPerMillion))
    return null;
  if (price.inputPerMillion < 0 || price.outputPerMillion < 0) return null;
  const input = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
  const output = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  const total = input + output;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** A short, stable summary for display and diagnostics. */
export function describeUsage(usage: TokenUsage | undefined): string {
  if (usage === undefined) return "tokens unknown";
  const parts = [`in ${usage.inputTokens}`, `out ${usage.outputTokens}`];
  if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens}`);
  if (usage.reasoningTokens !== undefined) parts.push(`reasoning ${usage.reasoningTokens}`);
  return parts.join(" / ");
}
