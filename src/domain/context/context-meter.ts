/**
 * Context meter.
 *
 * Reports how much of the window the current conversation occupies, so the user
 * can see the budget before it is exhausted. Miyu's `agent/context_meter.rs`
 * solves the same problem and records the lesson this module follows: a local
 * tokenizer estimate is only a fallback, and the authoritative number is the
 * provider's own `usage` from the last request.
 *
 * Two sources, in priority order:
 *
 * 1. **Measured**: the `inputTokens` of the newest validated response. That is the
 *    provider's own count of the prompt it just received, including the cache.
 * 2. **Estimated**: a local estimate over the conversation, used when no measured
 *    value exists yet (before the first response) or when the conversation has
 *    grown past the measured point.
 *
 * The estimate is deliberately coarse. A precise local tokenizer would be a large
 * dependency for a number that is displayed, not acted on: compaction decisions use
 * the conservative C04 budget, not this figure.
 */

export const METER_LIMITS = Object.freeze({
  /** Characters per token for the coarse estimate. */
  charsPerToken: 4,
  /** Per-message overhead: role markers, separators. */
  messageOverheadTokens: 4,
  /** Per-tool-call overhead: the id, name and argument braces. */
  toolCallOverheadTokens: 12,
});

export type ContextMeterSource = "measured" | "estimated";

export type ContextMeter = Readonly<{
  /** Tokens the current conversation occupies. */
  used: number;
  /** The verified window, or null when unknown. */
  window: number | null;
  /** used / window, clamped to [0, 1]; null when the window is unknown. */
  fraction: number | null;
  /** Where the number came from. */
  source: ContextMeterSource;
  /** Prompt size at which compaction runs, from the C04 budget. */
  compactionTrigger: number | null;
  /** True when the used figure is at or past the compaction trigger. */
  atCompaction: boolean;
}>;

export type MeterConversationItem =
  | Readonly<{ kind: "user"; text: string }>
  | Readonly<{
      kind: "assistant";
      text: string | null;
      toolCalls: readonly Readonly<{ toolName: string; arguments: unknown }>[];
    }>
  | Readonly<{ kind: "tool_result"; text: string | null }>;

/**
 * Coarse local estimate.
 *
 * Text is counted at four characters per token. That is wrong for code and for CJK
 * in opposite directions, which is why the figure is labelled as an estimate and
 * replaced by the provider's count as soon as one exists.
 */
export function estimateConversationTokens(items: readonly MeterConversationItem[]): number {
  let total = 0;
  for (const item of items) {
    total += METER_LIMITS.messageOverheadTokens;
    if (item.kind === "user") {
      total += textTokens(item.text);
      continue;
    }
    if (item.kind === "assistant") {
      total += textTokens(item.text ?? "");
      for (const call of item.toolCalls) {
        total += METER_LIMITS.toolCallOverheadTokens;
        total += textTokens(call.toolName);
        total += textTokens(safeStringify(call.arguments));
      }
      continue;
    }
    total += textTokens(item.text ?? "");
  }
  return total;
}

function textTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / METER_LIMITS.charsPerToken);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export type MeterInput = Readonly<{
  conversation: readonly MeterConversationItem[];
  /** Provider-reported prompt tokens for the newest request, when known. */
  measuredInputTokens: number | null;
  window: number | null;
  compactionTrigger: number | null;
  /** Tokens sent as fixed instructions and tool schemas, added to both sources. */
  fixedTokens: number;
}>;

/**
 * Build the meter reading.
 *
 * A measured value is used only when it covers the whole conversation. Once the
 * conversation has grown since the last response, the estimate takes over: adding
 * the measured figure to the estimate of the new tail would double-count, and
 * reporting the stale measured value would understate the current size.
 */
export function readContextMeter(input: MeterInput): ContextMeter {
  const estimated = estimateConversationTokens(input.conversation) + input.fixedTokens;
  const measured =
    input.measuredInputTokens === null ? null : input.measuredInputTokens + input.fixedTokens;

  // The measured figure describes the prompt as it was sent. The estimate describes
  // it now. Taking the larger is the honest choice: it never claims the conversation
  // is smaller than either source says.
  const used = measured === null ? estimated : Math.max(measured, 0);
  const source: ContextMeterSource = measured === null ? "estimated" : "measured";

  const window = input.window;
  const fraction = window === null || window <= 0 ? null : Math.min(1, Math.max(0, used / window));
  const compactionTrigger = input.compactionTrigger;
  return {
    used,
    window,
    fraction,
    source,
    compactionTrigger,
    atCompaction: compactionTrigger !== null && used >= compactionTrigger,
  };
}

/**
 * A short footer segment.
 *
 * Percent only when the window is known: a bare token count means nothing without
 * something to compare it to, and inventing a denominator would be worse than
 * showing the raw figure.
 */
export function describeMeter(meter: ContextMeter | null): string | null {
  if (meter === null) return null;
  if (meter.used === 0) return null;
  if (meter.window === null || meter.fraction === null) return `ctx ${compact(meter.used)}`;
  const percent = Math.floor(meter.fraction * 100);
  const marker = meter.atCompaction ? " !" : "";
  return `ctx ${percent}%${marker}`;
}

function compact(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}
