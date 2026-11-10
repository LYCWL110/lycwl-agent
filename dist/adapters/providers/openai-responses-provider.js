import { protocolEndpoint } from "../../domain/config/provider-config.js";
import { parseOpenAiResponsesUsage } from "../../domain/model-request/token-usage.js";
import { providerHttpsPost, } from "./provider-http.js";
import { classifyHttpStatus, isRecord, parseJsonBody, requireString, transportFailure, } from "./provider-response.js";
/**
 * OpenAI Responses adapter.
 *
 * The third protocol family. It differs from Chat Completions in ways that matter:
 *
 * - the request carries an `input` array of typed items rather than `messages`;
 * - instructions are a top-level `instructions` field, not a system message;
 * - the reply has an `output` array where a function call is its own item, and the
 *   arguments are a JSON **string** keyed by `call_id`;
 * - a function result is an `function_call_output` item keyed by `call_id`;
 * - the response can be marked `incomplete`, which must not yield executable calls.
 *
 * Transport and status classification are shared, so the Runtime sees the same
 * retry categories from every protocol.
 */
export const OPENAI_RESPONSES_DEFAULTS = Object.freeze({
    path: "/v1/responses",
    maxOutputTokens: 4_096,
    providerLabel: "openai_responses",
});
export class OpenAiResponsesProvider {
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
            return { kind: "authentication_failure", safeCode: "openai_responses_key_not_configured" };
        }
        if (request.signal?.aborted)
            return { kind: "cancelled", safeCode: "provider_cancelled" };
        const posted = await this.#post({
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            url: protocolEndpoint(this.#options.baseUrl, "openai_responses"),
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            bodyText: JSON.stringify(buildResponsesRequestBody(request.compaction === undefined
                ? this.#options
                : {
                    ...this.#options,
                    tools: [],
                    maxOutputTokens: Math.min(this.#options.maxOutputTokens ?? OPENAI_RESPONSES_DEFAULTS.maxOutputTokens, request.compaction.maxOutputTokens),
                }, request.conversation)),
            ...(this.#options.trustedCaPem === undefined
                ? {}
                : { trustedCaPem: this.#options.trustedCaPem }),
        });
        if (!posted.ok)
            return transportFailure(posted.code);
        const statusOutcome = classifyHttpStatus(posted.status, posted.headers, OPENAI_RESPONSES_DEFAULTS.providerLabel);
        if (statusOutcome !== null)
            return statusOutcome;
        return interpretResponsesResponse(posted.bodyText);
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
export function buildResponsesRequestBody(options, conversation) {
    return {
        model: options.model,
        max_output_tokens: options.maxOutputTokens ?? OPENAI_RESPONSES_DEFAULTS.maxOutputTokens,
        ...(options.reasoningEffort === undefined || options.reasoningEffort === "default"
            ? {}
            : { reasoning: { effort: options.reasoningEffort } }),
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        input: toResponsesInput(conversation),
        ...(options.tools === undefined || options.tools.length === 0
            ? {}
            : {
                tools: options.tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                })),
            }),
    };
}
/**
 * Map neutral items to Responses input items.
 *
 * A user or assistant turn becomes a `message` with a content array; a function
 * call is a top-level item, and its result is a separate `function_call_output`.
 * Flattening these into messages, as the chat protocol does, would be rejected.
 */
function toResponsesInput(conversation) {
    const items = [];
    for (const item of conversation) {
        if (item.kind === "user") {
            items.push({
                type: "message",
                role: "user",
                content: [
                    // Responses uses input_image with a data URL, in the same content array as
                    // the text.
                    ...(item.images ?? []).map((image) => ({
                        type: "input_image",
                        image_url: `data:${image.mediaType};base64,${image.base64}`,
                    })),
                    { type: "input_text", text: item.text },
                ],
            });
            continue;
        }
        if (item.kind === "assistant") {
            if (item.text !== null && item.text.length > 0) {
                items.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: item.text }],
                });
            }
            for (const call of item.toolCalls) {
                items.push({
                    type: "function_call",
                    call_id: call.providerToolCallId,
                    name: call.toolName,
                    // A JSON string, like the chat protocol.
                    arguments: JSON.stringify(call.arguments ?? {}),
                });
            }
            continue;
        }
        items.push({
            type: "function_call_output",
            call_id: item.providerToolCallId,
            // The status is not part of the protocol, so a failure is stated in the text
            // rather than dropped.
            output: item.status === "succeeded"
                ? (item.text ?? "")
                : `[${item.status}] ${item.text ?? ""}`.trim(),
        });
    }
    return items;
}
/**
 * Interpret a Responses reply.
 *
 * Only `message` text and `function_call` items become a completion. Reasoning
 * items are dropped: they are provider narration, not Harness-recordable results.
 * An `incomplete` response is rejected so its calls cannot execute.
 */
export function interpretResponsesResponse(bodyText) {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok) {
        return { kind: "invalid_response", safeCode: "openai_responses_body_not_json" };
    }
    if (!isRecord(parsed.value)) {
        return { kind: "invalid_response", safeCode: "openai_responses_body_not_object" };
    }
    const record = parsed.value;
    if (isRecord(record["error"])) {
        return { kind: "invalid_response", safeCode: "openai_responses_error_payload" };
    }
    // A truncated or incomplete response must not produce executable calls.
    if (record["status"] === "incomplete") {
        return { kind: "invalid_response", safeCode: "openai_responses_incomplete" };
    }
    if (record["status"] === "failed") {
        return { kind: "invalid_response", safeCode: "openai_responses_failed" };
    }
    const output = record["output"];
    if (!Array.isArray(output)) {
        return { kind: "invalid_response", safeCode: "openai_responses_output_missing" };
    }
    const toolCalls = [];
    const textParts = [];
    for (const entry of output) {
        if (!isRecord(entry)) {
            return { kind: "invalid_response", safeCode: "openai_responses_item_invalid" };
        }
        const type = entry["type"];
        if (type === "message") {
            const content = entry["content"];
            if (!Array.isArray(content)) {
                return { kind: "invalid_response", safeCode: "openai_responses_content_invalid" };
            }
            for (const block of content) {
                if (!isRecord(block)) {
                    return { kind: "invalid_response", safeCode: "openai_responses_content_invalid" };
                }
                const blockType = block["type"];
                if (blockType === "output_text") {
                    const text = requireString(block, "text");
                    if (!text.ok) {
                        return { kind: "invalid_response", safeCode: "openai_responses_text_invalid" };
                    }
                    textParts.push(text.value);
                    continue;
                }
                if (blockType === "refusal") {
                    // A refusal is a real answer, but it is not model content the Harness
                    // should present as an assistant message.
                    return { kind: "invalid_response", safeCode: "openai_responses_refusal" };
                }
                return { kind: "invalid_response", safeCode: "openai_responses_block_unknown" };
            }
            continue;
        }
        if (type === "function_call") {
            const callId = requireString(entry, "call_id");
            const name = requireString(entry, "name");
            if (!callId.ok || callId.value.length === 0 || !name.ok || name.value.length === 0) {
                return { kind: "invalid_response", safeCode: "openai_responses_call_invalid" };
            }
            const rawArguments = entry["arguments"];
            let args = {};
            if (typeof rawArguments === "string" && rawArguments.trim().length === 0) {
                args = {};
            }
            else if (typeof rawArguments === "string") {
                try {
                    args = JSON.parse(rawArguments);
                }
                catch {
                    return { kind: "invalid_response", safeCode: "openai_responses_arguments_not_json" };
                }
            }
            else if (rawArguments !== undefined && rawArguments !== null) {
                return { kind: "invalid_response", safeCode: "openai_responses_arguments_invalid" };
            }
            toolCalls.push({
                providerToolCallId: callId.value,
                toolName: name.value,
                arguments: args,
            });
            continue;
        }
        // Provider narration this Harness does not record as content.
        if (type === "reasoning")
            continue;
        return { kind: "invalid_response", safeCode: "openai_responses_item_unknown" };
    }
    const usage = parseOpenAiResponsesUsage(record);
    return {
        kind: "completed",
        toolCalls,
        text: textParts.length === 0 ? null : textParts.join(""),
        ...(usage === undefined ? {} : { usage }),
    };
}
