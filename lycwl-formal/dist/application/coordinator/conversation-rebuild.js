import { validateNeutralHistory } from "../../domain/model-request/neutral-history.js";
/**
 * Replay terminal Runs in event order. Each validated response owns its calls;
 * unfinished Runs are discarded as a unit, including their compaction changes.
 */
export function rebuildConversation(events) {
    let conversation = [];
    let working = null;
    let runId = null;
    let runs = 0;
    let turn = null;
    const expected = new Map();
    const internalCalls = new Map();
    const openCalls = new Map();
    const queued = new Map();
    const pendingInputs = [];
    let invalid = null;
    const fail = (detail) => ({
        ok: false,
        code: "unpaired_tool_call",
        detail,
    });
    const appendInputs = () => {
        if (working === null || openCalls.size > 0)
            return;
        for (const text of pendingInputs)
            working.push({ kind: "user", text });
        pendingInputs.length = 0;
    };
    const finishCall = (call, status, text) => {
        if (working === null || call === undefined || !openCalls.delete(call.providerToolCallId)) {
            invalid = "tool result has no matching open call";
            return;
        }
        working.push({
            kind: "tool_result",
            providerToolCallId: call.providerToolCallId,
            toolName: call.toolName,
            status,
            text,
        });
        appendInputs();
    };
    for (const event of events) {
        const payload = event.payload;
        if (payload.kind === "run_started") {
            working = [...conversation, { kind: "user", text: payload.input }];
            runId = event.runId;
            turn = null;
            expected.clear();
            internalCalls.clear();
            openCalls.clear();
            queued.clear();
            pendingInputs.length = 0;
            invalid = null;
            continue;
        }
        if (working === null || event.runId !== runId)
            continue;
        switch (payload.kind) {
            case "model_response_validated":
                appendInputs();
                turn = { kind: "assistant", text: payload.text, toolCalls: [...(payload.toolCalls ?? [])] };
                working.push(turn);
                expected.set(turn, payload.toolCallCount);
                for (const call of turn.toolCalls) {
                    if (openCalls.has(call.providerToolCallId))
                        invalid = "duplicate open call";
                    openCalls.set(call.providerToolCallId, call);
                }
                break;
            case "tool_call_received": {
                if (turn === null) {
                    invalid = "tool call has no response";
                    break;
                }
                let call = turn.toolCalls.find((entry) => entry.providerToolCallId === payload.providerToolCallId);
                if (call === undefined) {
                    // Older logs carry calls only on the received event.
                    call = {
                        providerToolCallId: payload.providerToolCallId,
                        toolName: payload.toolName,
                        arguments: payload.arguments,
                    };
                    turn.toolCalls.push(call);
                    openCalls.set(call.providerToolCallId, call);
                }
                internalCalls.set(payload.toolCallId, call);
                break;
            }
            case "tool_execution_finished":
                finishCall(internalCalls.get(payload.toolCallId), payload.status, payload.text);
                break;
            case "tool_execution_denied":
                finishCall(internalCalls.get(payload.toolCallId), "denied", null);
                break;
            case "tool_call_cancelled":
                finishCall(internalCalls.get(payload.toolCallId) ??
                    (payload.providerToolCallId === undefined
                        ? undefined
                        : openCalls.get(payload.providerToolCallId)), "cancelled", null);
                break;
            case "run_input_queued":
                queued.set(payload.inputId, payload.text);
                break;
            case "run_input_withdrawn":
                queued.delete(payload.inputId);
                break;
            case "run_input_batch_consumed":
                for (const id of payload.inputIds) {
                    const text = queued.get(id);
                    if (text === undefined)
                        invalid = "consumed input has no queued source";
                    else
                        pendingInputs.push(text);
                    queued.delete(id);
                }
                // Cancellation events can follow consumption in the durable log. Keep
                // user text after the call/result group, matching the live conversation.
                appendInputs();
                break;
            case "context_compacted": {
                const valid = validateNeutralHistory(working.map((item, index) => ({ ...item, sourceId: `replay-${index}` })));
                if (!valid.ok)
                    invalid = valid.detail;
                working = compactConversation(working, payload.recentSuffixGroupIds.length, payload.summaryText, payload.pinnedUserInputs ?? []);
                turn = null;
                break;
            }
            case "run_completed":
            case "run_failed":
            case "run_cancelled": {
                appendInputs();
                for (const [item, count] of expected) {
                    if (item.kind === "assistant" && item.toolCalls.length !== count) {
                        invalid = "recorded response is missing tool calls";
                    }
                }
                const valid = validateNeutralHistory(working.map((item, index) => ({ ...item, sourceId: `replay-${index}` })));
                if (invalid !== null)
                    return fail(invalid);
                if (!valid.ok)
                    return fail(valid.detail);
                conversation = working;
                working = null;
                runs += 1;
                break;
            }
            default:
                break;
        }
    }
    return { ok: true, conversation, runs };
}
export function compactConversation(conversation, recentGroups, summaryText, pinnedUserInputs) {
    const pinned = new Set(pinnedUserInputs);
    return [
        { kind: "user", text: summaryText },
        ...pinnedUserInputs.map((text) => ({ kind: "user", text })),
        ...retainRecentGroups(conversation, recentGroups).filter((item) => item.kind !== "user" || !pinned.has(item.text)),
    ];
}
/** Retain whole assistant/call/result groups, rather than slicing by item count. */
export function retainRecentGroups(conversation, count) {
    if (count <= 0)
        return [];
    const starts = [];
    for (const [index, item] of conversation.entries()) {
        if (item.kind !== "tool_result")
            starts.push(index);
    }
    const start = starts[Math.max(0, starts.length - count)] ?? conversation.length;
    return conversation.slice(start);
}
export function trimConversation(conversation, maxItems) {
    if (maxItems <= 0)
        return [];
    if (conversation.length <= maxItems)
        return [...conversation];
    let start = conversation.length - maxItems;
    while (start < conversation.length && conversation[start]?.kind !== "user")
        start += 1;
    return conversation.slice(start);
}
