import { protocolEndpoint } from "../../domain/config/provider-config.js";
import { parseOpenAiChatUsage } from "../../domain/model-request/token-usage.js";
import { providerHttpsPost, } from "./provider-http.js";
import { classifyHttpStatus, isRecord, parseJsonBody, requireString, transportFailure, } from "./provider-response.js";
/**
 * OpenAI Chat Completions adapter.
 *
 * The second protocol family in the selected set. It shares the transport and the
 * status classification with the Anthropic adapter so the Runtime's retry policy
 * sees the same categories from both, and it normalizes the same neutral
 * conversation shape.
 *
 * Structural differences from Messages that this adapter owns:
 * - tool calls live on the assistant message as `tool_calls`, each with a JSON
 *   string `arguments`;
 * - tool results are their own `role: "tool"` messages keyed by `tool_call_id`;
 * - the system prompt is a message with `role: "system"` rather than a top-level
 *   field.
 */
export const OPENAI_CHAT_DEFAULTS = Object.freeze({
    path: "/v1/chat/completions",
    maxTokens: 4_096,
    providerLabel: "openai_chat",
});
export class OpenAiChatProvider {
    #options;
    #post;
    constructor(options) {
        this.#options = options;
        this.#post = options.post ?? providerHttpsPost;
    }
    async complete(request) {
        if (request.signal?.aborted)
            return { kind: "cancelled", safeCode: "provider_cancelled" };
        const apiKey = await this.#resolveKey();
        if (apiKey === null) {
            return { kind: "authentication_failure", safeCode: "openai_chat_key_not_configured" };
        }
        if (request.signal?.aborted)
            return { kind: "cancelled", safeCode: "provider_cancelled" };
        const posted = await this.#post({
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            url: protocolEndpoint(this.#options.baseUrl, "openai_chat"),
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            bodyText: JSON.stringify(buildChatRequestBody(request.compaction === undefined
                ? this.#options
                : {
                    ...this.#options,
                    tools: [],
                    maxTokens: Math.min(this.#options.maxTokens ?? OPENAI_CHAT_DEFAULTS.maxTokens, request.compaction.maxOutputTokens),
                }, request.conversation)),
            ...(this.#options.trustedCaPem === undefined
                ? {}
                : { trustedCaPem: this.#options.trustedCaPem }),
        });
        if (!posted.ok)
            return transportFailure(posted.code);
        const statusOutcome = classifyHttpStatus(posted.status, posted.headers, OPENAI_CHAT_DEFAULTS.providerLabel);
        if (statusOutcome !== null)
            return statusOutcome;
        return interpretChatResponse(posted.bodyText);
    }
    async #resolveKey() {
        try {
            const key = await this.#options.resolveApiKey();
            if (key === null || key.length === 0)
                return null;
            return key;
        }
        catch {
            return null;
        }
    }
}
/** Exported for tests: the exact JSON that would be sent. */
export function buildChatRequestBody(options, conversation) {
    return {
        model: options.model,
        ...(options.reasoningEffort === undefined || options.reasoningEffort === "default"
            ? { max_tokens: options.maxTokens ?? OPENAI_CHAT_DEFAULTS.maxTokens }
            : {
                max_completion_tokens: options.maxTokens ?? OPENAI_CHAT_DEFAULTS.maxTokens,
                reasoning_effort: options.reasoningEffort,
            }),
        messages: toChatMessages(conversation, options.system),
        ...(options.tools === undefined || options.tools.length === 0
            ? {}
            : {
                tools: options.tools.map((tool) => ({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                })),
            }),
    };
}
/**
 * Map neutral items to chat messages.
 *
 * `arguments` is a JSON *string* here, unlike Messages where it is an object. An
 * empty argument set must serialize as `"{}"`, not `""`, or a strict provider
 * rejects the tool call.
 */
function toChatMessages(conversation, system) {
    const messages = [];
    if (system !== undefined)
        messages.push({ role: "system", content: system });
    for (const item of conversation) {
        if (item.kind === "user") {
            // Chat Completions takes images as content parts. The data URL carries the
            // media type because this protocol has no separate field for it.
            if (item.images === undefined || item.images.length === 0) {
                messages.push({ role: "user", content: item.text });
                continue;
            }
            messages.push({
                role: "user",
                content: [
                    ...item.images.map((image) => ({
                        type: "image_url",
                        image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
                    })),
                    { type: "text", text: item.text },
                ],
            });
            continue;
        }
        if (item.kind === "assistant") {
            const toolCalls = item.toolCalls.map((call) => ({
                id: call.providerToolCallId,
                type: "function",
                function: {
                    name: call.toolName,
                    arguments: JSON.stringify(call.arguments ?? {}),
                },
            }));
            const message = {
                role: "assistant",
                // A null content is legal when the turn is purely tool calls.
                content: item.text,
            };
            if (toolCalls.length > 0)
                message["tool_calls"] = toolCalls;
            messages.push(message);
            continue;
        }
        messages.push({
            role: "tool",
            tool_call_id: item.providerToolCallId,
            // The status is not part of the chat protocol, so a failed result is
            // expressed in the text rather than dropped: the model must know the call
            // did not succeed.
            content: item.status === "succeeded"
                ? (item.text ?? "")
                : `[${item.status}] ${item.text ?? ""}`.trim(),
        });
    }
    return messages;
}
/**
 * Interpret a chat completion.
 *
 * The first choice is used. A response with no choices, or with a `finish_reason`
 * indicating truncation, is rejected rather than partially accepted: executing a
 * tool call from a truncated response is exactly what the baseline forbids.
 */
export function interpretChatResponse(bodyText) {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok)
        return { kind: "invalid_response", safeCode: "openai_chat_body_not_json" };
    if (!isRecord(parsed.value)) {
        return { kind: "invalid_response", safeCode: "openai_chat_body_not_object" };
    }
    const record = parsed.value;
    if (isRecord(record["error"])) {
        return { kind: "invalid_response", safeCode: "openai_chat_error_payload" };
    }
    const choices = record["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
        return { kind: "invalid_response", safeCode: "openai_chat_choices_missing" };
    }
    const first = choices[0];
    if (!isRecord(first)) {
        return { kind: "invalid_response", safeCode: "openai_chat_choice_invalid" };
    }
    const finishReason = first["finish_reason"];
    if (finishReason === "length") {
        // A truncated turn must not yield executable calls.
        return { kind: "invalid_response", safeCode: "openai_chat_truncated" };
    }
    if (finishReason === "content_filter") {
        return { kind: "invalid_response", safeCode: "openai_chat_content_filtered" };
    }
    const message = first["message"];
    if (!isRecord(message)) {
        return { kind: "invalid_response", safeCode: "openai_chat_message_missing" };
    }
    const toolCalls = [];
    const rawCalls = message["tool_calls"];
    if (rawCalls !== undefined) {
        if (!Array.isArray(rawCalls)) {
            return { kind: "invalid_response", safeCode: "openai_chat_tool_calls_invalid" };
        }
        for (const entry of rawCalls) {
            if (!isRecord(entry)) {
                return { kind: "invalid_response", safeCode: "openai_chat_tool_call_invalid" };
            }
            const id = requireString(entry, "id");
            const fn = entry["function"];
            if (!id.ok || id.value.length === 0 || !isRecord(fn)) {
                return { kind: "invalid_response", safeCode: "openai_chat_tool_call_invalid" };
            }
            const name = requireString(fn, "name");
            if (!name.ok || name.value.length === 0) {
                return { kind: "invalid_response", safeCode: "openai_chat_tool_call_invalid" };
            }
            // `arguments` is a JSON string. Malformed JSON is rejected rather than
            // passed on as an empty object, because that would silently change the call.
            const rawArguments = fn["arguments"];
            let args = {};
            if (typeof rawArguments === "string" && rawArguments.trim().length === 0) {
                // An empty string is what some providers send for a tool that takes no
                // arguments; treating it as malformed would reject a valid call.
                args = {};
            }
            else if (typeof rawArguments === "string") {
                try {
                    args = JSON.parse(rawArguments);
                }
                catch {
                    return { kind: "invalid_response", safeCode: "openai_chat_arguments_not_json" };
                }
            }
            else if (rawArguments === undefined || rawArguments === null) {
                // Absent arguments mean the tool takes none.
                args = {};
            }
            else {
                return { kind: "invalid_response", safeCode: "openai_chat_arguments_invalid" };
            }
            toolCalls.push({
                providerToolCallId: id.value,
                toolName: name.value,
                arguments: args,
            });
        }
    }
    const content = message["content"];
    let text = null;
    if (typeof content === "string") {
        text = content.length === 0 ? null : content;
    }
    else if (content !== null && content !== undefined) {
        return { kind: "invalid_response", safeCode: "openai_chat_content_invalid" };
    }
    const usage = parseOpenAiChatUsage(record);
    return {
        kind: "completed",
        toolCalls,
        text,
        ...(usage === undefined ? {} : { usage }),
    };
}
