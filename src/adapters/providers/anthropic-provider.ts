import {
  protocolReasoningEfforts,
  type ReasoningEffort,
} from "../../domain/config/provider-config.ts";
import { parseAnthropicUsage } from "../../domain/model-request/token-usage.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderConversationItem,
  ProviderDelta,
  ProviderRequest,
  ProviderToolCall,
} from "../../ports/model-provider.ts";
import {
  type ProviderHttpFailure,
  type ProviderHttpRequest,
  type ProviderHttpResult,
  providerHttpsPost,
  providerHttpsPostStream,
} from "./provider-http.ts";
import {
  classifyHttpStatus,
  isRecord,
  parseJsonBody,
  requireString,
  transportFailure,
} from "./provider-response.ts";
import type { SseEvent } from "./provider-sse.ts";

/**
 * Anthropic Messages adapter.
 *
 * Responsibilities, and deliberately nothing more: build the request body from a
 * neutral conversation, POST it, and normalize the reply into a completion. It does
 * not dispatch tools, decide permissions, retry, or hold a credential value beyond
 * the single request that uses it.
 *
 * The credential is fetched through an injected resolver at call time, so a
 * rotation applies to the next attempt and no secret is stored in this object.
 */

export const ANTHROPIC_DEFAULTS = Object.freeze({
  endpoint: "https://api.anthropic.com/v1/messages",
  apiVersion: "2023-06-01",
  maxTokens: 4_096,
  /** Tool definitions are declared by the caller; this adapter never invents one. */
  providerLabel: "anthropic",
});

export type AnthropicToolDefinition = Readonly<{
  name: string;
  description: string;
  /** JSON Schema for the tool input. Passed through unchanged. */
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export type AnthropicAdapterOptions = Readonly<{
  /** Resolve the API key at call time; never stored on the adapter. */
  resolveApiKey: () => Promise<string | null>;
  model: string;
  endpoint?: string;
  apiVersion?: string;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Tool definitions available for this Run. Empty means no tools. */
  tools?: readonly AnthropicToolDefinition[];
  /** Optional system prompt. Trusted Harness rules only; never project text. */
  system?: string;
  /** Injected transport for tests. Production uses the real bounded POST. */
  post?: (input: ProviderHttpRequest) => Promise<ProviderHttpResult>;
  /** Injected SSE transport for tests. Production uses the real streaming POST. */
  streamPost?: (
    input: ProviderHttpRequest,
    onEvent: (event: SseEvent) => void,
  ) => Promise<ProviderHttpResult>;
  trustedCaPem?: string;
}>;

export class AnthropicProvider implements ModelProvider {
  readonly #options: AnthropicAdapterOptions;
  readonly #post: (input: ProviderHttpRequest) => Promise<ProviderHttpResult>;
  readonly #streamPost: (
    input: ProviderHttpRequest,
    onEvent: (event: SseEvent) => void,
  ) => Promise<ProviderHttpResult>;

  constructor(options: AnthropicAdapterOptions) {
    this.#options = options;
    this.#post = options.post ?? providerHttpsPost;
    const post = options.post;
    this.#streamPost =
      options.streamPost ?? (post === undefined ? providerHttpsPostStream : (input) => post(input));
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    if (request.signal?.aborted) return { kind: "cancelled", safeCode: "provider_cancelled" };
    if (
      this.#options.reasoningEffort !== undefined &&
      !protocolReasoningEfforts("anthropic_messages").includes(this.#options.reasoningEffort)
    )
      return { kind: "invalid_response", safeCode: "anthropic_reasoning_effort_invalid" };
    const apiKey = await this.#resolveKey();
    if (apiKey === null) {
      return { kind: "authentication_failure", safeCode: "anthropic_key_not_configured" };
    }

    const body = buildRequestBody(
      request.compaction === undefined
        ? this.#options
        : {
            ...this.#options,
            tools: [],
            maxTokens: Math.min(
              this.#options.maxTokens ?? ANTHROPIC_DEFAULTS.maxTokens,
              request.compaction.maxOutputTokens,
            ),
          },
      request.conversation,
    );

    if (request.signal?.aborted) return { kind: "cancelled", safeCode: "provider_cancelled" };
    const posted = await this.#post({
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      url: this.#options.endpoint ?? ANTHROPIC_DEFAULTS.endpoint,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": this.#options.apiVersion ?? ANTHROPIC_DEFAULTS.apiVersion,
        // The credential travels as a header and is never placed in the body, an
        // event, a log or an attachment.
        "x-api-key": apiKey,
      },
      bodyText: JSON.stringify(body),
      ...(this.#options.trustedCaPem === undefined
        ? {}
        : { trustedCaPem: this.#options.trustedCaPem }),
    });

    if (!posted.ok) return transportFailure(posted.code as ProviderHttpFailure);

    const statusOutcome = classifyHttpStatus(
      posted.status,
      posted.headers,
      ANTHROPIC_DEFAULTS.providerLabel,
    );
    if (statusOutcome !== null) return statusOutcome;

    return interpretMessageResponse(posted.bodyText);
  }

  async stream(
    request: ProviderRequest,
    onDelta: (delta: ProviderDelta) => void,
  ): Promise<ProviderCompletion> {
    if (request.signal?.aborted) return { kind: "cancelled", safeCode: "provider_cancelled" };
    if (
      this.#options.reasoningEffort !== undefined &&
      !protocolReasoningEfforts("anthropic_messages").includes(this.#options.reasoningEffort)
    )
      return { kind: "invalid_response", safeCode: "anthropic_reasoning_effort_invalid" };
    const apiKey = await this.#resolveKey();
    if (apiKey === null) {
      return { kind: "authentication_failure", safeCode: "anthropic_key_not_configured" };
    }
    if (request.signal?.aborted) return { kind: "cancelled", safeCode: "provider_cancelled" };

    const state = createAnthropicStreamState();
    const posted = await this.#streamPost(
      {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        url: this.#options.endpoint ?? ANTHROPIC_DEFAULTS.endpoint,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version": this.#options.apiVersion ?? ANTHROPIC_DEFAULTS.apiVersion,
          "x-api-key": apiKey,
        },
        bodyText: JSON.stringify(
          buildRequestBody(
            request.compaction === undefined
              ? this.#options
              : {
                  ...this.#options,
                  tools: [],
                  maxTokens: Math.min(
                    this.#options.maxTokens ?? ANTHROPIC_DEFAULTS.maxTokens,
                    request.compaction.maxOutputTokens,
                  ),
                },
            request.conversation,
            true,
          ),
        ),
        ...(this.#options.trustedCaPem === undefined
          ? {}
          : { trustedCaPem: this.#options.trustedCaPem }),
      },
      (event) => {
        applyAnthropicStreamEvent(state, event, onDelta);
      },
    );

    if (!posted.ok) return transportFailure(posted.code as ProviderHttpFailure);

    const statusOutcome = classifyHttpStatus(
      posted.status,
      posted.headers,
      ANTHROPIC_DEFAULTS.providerLabel,
    );
    if (statusOutcome !== null) return statusOutcome;

    // A provider that ignored `stream` answered with a normal JSON body.
    if (posted.bodyText.length > 0) return interpretMessageResponse(posted.bodyText);
    if (posted.eventStream !== true) {
      return { kind: "invalid_response", safeCode: "anthropic_stream_missing" };
    }
    return finishAnthropicStream(state);
  }

  async #resolveKey(): Promise<string | null> {
    try {
      const key = await this.#options.resolveApiKey();
      // ADR-0007: reject an empty credential; no universal minimum length.
      if (key === null || key.length === 0) return null;
      return key;
    } catch {
      // A vault failure means no send; it must not look like a valid request.
      return null;
    }
  }
}

/** Exported for tests: the exact JSON that would be sent. */
export function buildRequestBody(
  options: AnthropicAdapterOptions,
  conversation: readonly ProviderConversationItem[],
  stream = false,
): Readonly<Record<string, unknown>> {
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULTS.maxTokens,
    ...(stream ? { stream: true } : {}),
    ...(options.reasoningEffort === undefined || options.reasoningEffort === "default"
      ? {}
      : { output_config: { effort: options.reasoningEffort } }),
    ...(options.system === undefined ? {} : { system: options.system }),
    messages: toAnthropicMessages(conversation),
    ...(options.tools === undefined || options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
  };
}

/**
 * Map neutral items to Anthropic messages.
 *
 * The assistant turn must carry its `tool_use` blocks, and each `tool_result` must
 * reference the id the assistant produced. A history that violated this would be
 * rejected by the vendor, which is why `validateNeutralHistory` exists; this
 * function trusts that check has already run.
 */
function toAnthropicMessages(
  conversation: readonly ProviderConversationItem[],
): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  for (const item of conversation) {
    if (item.kind === "user") {
      // Anthropic takes images as content blocks, and the image must precede the
      // text it refers to for the model to read it as "look at this, then answer".
      if (item.images === undefined || item.images.length === 0) {
        messages.push({ role: "user", content: item.text });
        continue;
      }
      messages.push({
        role: "user",
        content: [
          ...item.images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
          })),
          { type: "text", text: item.text },
        ],
      });
      continue;
    }
    if (item.kind === "assistant") {
      const content: Record<string, unknown>[] = [];
      if (item.text !== null && item.text.length > 0) {
        content.push({ type: "text", text: item.text });
      }
      for (const call of item.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.providerToolCallId,
          name: call.toolName,
          input: call.arguments ?? {},
        });
      }
      // An assistant turn with no text and no calls is not a valid message.
      if (content.length === 0) continue;
      messages.push({ role: "assistant", content });
      continue;
    }
    // tool_result blocks belong in a user turn, one message per result is legal
    // and keeps ordering obvious.
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: item.providerToolCallId,
          is_error: item.status !== "succeeded",
          content: item.text ?? "",
        },
      ],
    });
  }

  return messages;
}

/**
 * Interpret a Messages response.
 *
 * Only `text` and `tool_use` blocks become a completion. `thinking`,
 * `redacted_thinking` and server-tool blocks are ignored on purpose: they are
 * provider narration, not Harness-recordable results, and treating them as content
 * would let a vendor's internal step look like an executed action.
 */
export function interpretMessageResponse(bodyText: string): ProviderCompletion {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok) return { kind: "invalid_response", safeCode: "anthropic_body_not_json" };
  if (!isRecord(parsed.value)) {
    return { kind: "invalid_response", safeCode: "anthropic_body_not_object" };
  }

  const record = parsed.value;

  // An error object with a 2xx status is still an error.
  if (record["type"] === "error") {
    return { kind: "invalid_response", safeCode: "anthropic_error_payload" };
  }

  const content = record["content"];
  if (!Array.isArray(content)) {
    return { kind: "invalid_response", safeCode: "anthropic_content_missing" };
  }

  const toolCalls: ProviderToolCall[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (!isRecord(block)) {
      return { kind: "invalid_response", safeCode: "anthropic_block_invalid" };
    }
    const type = block["type"];

    if (type === "text") {
      const text = requireString(block, "text");
      if (!text.ok) return { kind: "invalid_response", safeCode: "anthropic_text_invalid" };
      textParts.push(text.value);
      continue;
    }

    if (type === "tool_use") {
      const id = requireString(block, "id");
      const name = requireString(block, "name");
      if (!id.ok || !name.ok || id.value.length === 0 || name.value.length === 0) {
        return { kind: "invalid_response", safeCode: "anthropic_tool_use_invalid" };
      }
      toolCalls.push({
        providerToolCallId: id.value,
        toolName: name.value,
        arguments: block["input"] ?? {},
      });
      continue;
    }

    // Provider narration this Harness does not record as content.
    if (type === "thinking" || type === "redacted_thinking") continue;
    if (type === "server_tool_use" || type === "web_search_tool_result") continue;

    // An unknown block is not silently skipped: a new block type could carry
    // something the Runtime must not ignore.
    return { kind: "invalid_response", safeCode: "anthropic_block_unknown" };
  }

  // Usage is optional: a provider that omits it leaves the cost unknown rather
  // than reporting zero.
  const usage = parseAnthropicUsage(record);
  return {
    kind: "completed",
    toolCalls,
    text: textParts.length === 0 ? null : textParts.join(""),
    ...(usage === undefined ? {} : { usage }),
  };
}

type AnthropicStreamBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      json: string;
      initialInput: unknown;
    }
  | { kind: "ignored" };

export type AnthropicStreamState = {
  blocks: Map<number, AnthropicStreamBlock>;
  messageUsage: Record<string, unknown> | null;
  outputTokens: number | null;
  stopReason: string | null;
  started: boolean;
  stopped: boolean;
  error: string | null;
};

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    blocks: new Map(),
    messageUsage: null,
    outputTokens: null,
    stopReason: null,
    started: false,
    stopped: false,
    error: null,
  };
}

/**
 * Apply one Anthropic SSE event.
 *
 * Text deltas are forwarded for display; tool-use JSON fragments are collected
 * and parsed only after the block closes. Nothing here executes a tool.
 */
export function applyAnthropicStreamEvent(
  state: AnthropicStreamState,
  event: SseEvent,
  onDelta: (delta: ProviderDelta) => void,
): void {
  if (state.error !== null) return;
  const parsed = parseJsonBody(event.data);
  if (!parsed.ok || !isRecord(parsed.value)) {
    state.error = "anthropic_stream_not_json";
    return;
  }
  const record = parsed.value;
  const type = event.event ?? (typeof record["type"] === "string" ? record["type"] : null);

  if (type === "message_start") {
    const message = record["message"];
    state.started = true;
    if (isRecord(message)) {
      const usage = message["usage"];
      if (isRecord(usage)) state.messageUsage = usage;
    }
    return;
  }

  if (type === "content_block_start") {
    const index = record["index"];
    const block = record["content_block"];
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !isRecord(block)
    ) {
      state.error = "anthropic_stream_block_invalid";
      return;
    }
    const blockType = block["type"];
    if (blockType === "text") {
      const text = typeof block["text"] === "string" ? block["text"] : "";
      state.blocks.set(index, { kind: "text", text });
      if (text.length > 0) onDelta({ kind: "text", text });
      return;
    }
    if (blockType === "tool_use") {
      const id = block["id"];
      const name = block["name"];
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        typeof name !== "string" ||
        name.length === 0
      ) {
        state.error = "anthropic_stream_tool_use_invalid";
        return;
      }
      state.blocks.set(index, {
        kind: "tool_use",
        id,
        name,
        json: "",
        initialInput: block["input"],
      });
      return;
    }
    if (
      blockType === "thinking" ||
      blockType === "redacted_thinking" ||
      blockType === "server_tool_use" ||
      blockType === "web_search_tool_result"
    ) {
      state.blocks.set(index, { kind: "ignored" });
      return;
    }
    state.error = "anthropic_block_unknown";
    return;
  }

  if (type === "content_block_delta") {
    const index = record["index"];
    const delta = record["delta"];
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !isRecord(delta)
    ) {
      state.error = "anthropic_stream_delta_invalid";
      return;
    }
    const block = state.blocks.get(index);
    if (block === undefined) {
      state.error = "anthropic_stream_delta_without_block";
      return;
    }
    // Thinking and server-tool blocks are narration this Harness does not record.
    // Their deltas must not be interpreted as text or tool input.
    if (block.kind === "ignored") return;
    const deltaType = delta["type"];
    if (deltaType === "text_delta") {
      if (block.kind !== "text") {
        state.error = "anthropic_stream_delta_invalid";
        return;
      }
      const text = delta["text"];
      if (typeof text !== "string") {
        state.error = "anthropic_stream_text_invalid";
        return;
      }
      block.text += text;
      if (text.length > 0) onDelta({ kind: "text", text });
      return;
    }
    if (deltaType === "input_json_delta") {
      if (block.kind !== "tool_use") {
        state.error = "anthropic_stream_delta_invalid";
        return;
      }
      const partial = delta["partial_json"];
      if (typeof partial !== "string") {
        state.error = "anthropic_stream_json_invalid";
        return;
      }
      block.json += partial;
      return;
    }
    if (deltaType === "thinking_delta" || deltaType === "signature_delta") {
      return;
    }
    state.error = "anthropic_delta_unknown";
    return;
  }

  if (type === "message_delta") {
    const delta = record["delta"];
    if (isRecord(delta) && typeof delta["stop_reason"] === "string") {
      state.stopReason = delta["stop_reason"];
    }
    const usage = record["usage"];
    if (isRecord(usage) && typeof usage["output_tokens"] === "number") {
      state.outputTokens = usage["output_tokens"];
    }
    return;
  }

  if (type === "message_stop") {
    state.stopped = true;
    return;
  }

  if (type === "error") {
    state.error = "anthropic_stream_error";
    return;
  }

  // `ping` and future event types are ignored; the final message_stop still
  // decides whether the response is complete.
}

export function finishAnthropicStream(state: AnthropicStreamState): ProviderCompletion {
  if (state.error !== null) {
    return { kind: "invalid_response", safeCode: state.error };
  }
  if (!state.started) {
    return { kind: "invalid_response", safeCode: "anthropic_stream_not_started" };
  }
  if (!state.stopped) {
    return { kind: "invalid_response", safeCode: "anthropic_stream_incomplete" };
  }
  if (state.stopReason === "max_tokens") {
    return { kind: "invalid_response", safeCode: "anthropic_truncated" };
  }

  const ordered = [...state.blocks.entries()].sort((left, right) => left[0] - right[0]);
  const textParts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  for (const [, block] of ordered) {
    if (block.kind === "text") {
      if (block.text.length > 0) textParts.push(block.text);
      continue;
    }
    if (block.kind === "tool_use") {
      let args: unknown = block.initialInput ?? {};
      if (block.json.trim().length > 0) {
        try {
          args = JSON.parse(block.json);
        } catch {
          return { kind: "invalid_response", safeCode: "anthropic_arguments_not_json" };
        }
      }
      toolCalls.push({
        providerToolCallId: block.id,
        toolName: block.name,
        arguments: args,
      });
    }
  }

  const usageRecord: Record<string, unknown> = { ...(state.messageUsage ?? {}) };
  if (state.outputTokens !== null) usageRecord["output_tokens"] = state.outputTokens;
  const usage =
    Object.keys(usageRecord).length === 0 ? undefined : parseAnthropicUsage({ usage: usageRecord });

  return {
    kind: "completed",
    toolCalls,
    text: textParts.length === 0 ? null : textParts.join(""),
    ...(usage === undefined ? {} : { usage }),
  };
}
