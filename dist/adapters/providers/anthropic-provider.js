import { protocolReasoningEfforts, } from "../../domain/config/provider-config.js";
import { parseAnthropicUsage } from "../../domain/model-request/token-usage.js";
import { providerHttpsPost, } from "./provider-http.js";
import { classifyHttpStatus, isRecord, parseJsonBody, requireString, transportFailure, } from "./provider-response.js";
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
export class AnthropicProvider {
    #options;
    #post;
    constructor(options) {
        this.#options = options;
        this.#post = options.post ?? providerHttpsPost;
    }
    async complete(request) {
        if (request.signal?.aborted)
            return { kind: "cancelled", safeCode: "provider_cancelled" };
        if (this.#options.reasoningEffort !== undefined &&
            !protocolReasoningEfforts("anthropic_messages").includes(this.#options.reasoningEffort))
            return { kind: "invalid_response", safeCode: "anthropic_reasoning_effort_invalid" };
        const apiKey = await this.#resolveKey();
        if (apiKey === null) {
            return { kind: "authentication_failure", safeCode: "anthropic_key_not_configured" };
        }
        const body = buildRequestBody(request.compaction === undefined
            ? this.#options
            : {
                ...this.#options,
                tools: [],
                maxTokens: Math.min(this.#options.maxTokens ?? ANTHROPIC_DEFAULTS.maxTokens, request.compaction.maxOutputTokens),
            }, request.conversation);
        if (request.signal?.aborted)
            return { kind: "cancelled", safeCode: "provider_cancelled" };
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
        if (!posted.ok)
            return transportFailure(posted.code);
        const statusOutcome = classifyHttpStatus(posted.status, posted.headers, ANTHROPIC_DEFAULTS.providerLabel);
        if (statusOutcome !== null)
            return statusOutcome;
        return interpretMessageResponse(posted.bodyText);
    }
    async #resolveKey() {
        try {
            const key = await this.#options.resolveApiKey();
            // ADR-0007: reject an empty credential; no universal minimum length.
            if (key === null || key.length === 0)
                return null;
            return key;
        }
        catch {
            // A vault failure means no send; it must not look like a valid request.
            return null;
        }
    }
}
/** Exported for tests: the exact JSON that would be sent. */
export function buildRequestBody(options, conversation) {
    return {
        model: options.model,
        max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULTS.maxTokens,
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
function toAnthropicMessages(conversation) {
    const messages = [];
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
            const content = [];
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
            if (content.length === 0)
                continue;
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
export function interpretMessageResponse(bodyText) {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok)
        return { kind: "invalid_response", safeCode: "anthropic_body_not_json" };
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
    const toolCalls = [];
    const textParts = [];
    for (const block of content) {
        if (!isRecord(block)) {
            return { kind: "invalid_response", safeCode: "anthropic_block_invalid" };
        }
        const type = block["type"];
        if (type === "text") {
            const text = requireString(block, "text");
            if (!text.ok)
                return { kind: "invalid_response", safeCode: "anthropic_text_invalid" };
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
        if (type === "thinking" || type === "redacted_thinking")
            continue;
        if (type === "server_tool_use" || type === "web_search_tool_result")
            continue;
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
