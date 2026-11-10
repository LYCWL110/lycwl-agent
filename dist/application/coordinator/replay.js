import { createRunBudget } from "../../domain/run/run-budget.js";
export async function replayRun(events, digests) {
    let previous = null;
    let state = "active";
    let finalText = null;
    let modelAttempts = 0;
    let safeFailureCode = null;
    let budget = createRunBudget();
    let costUnknown = false;
    const toolOutcomes = {};
    const openDispatches = new Set();
    for (const event of events) {
        if (event.seq !== (previous?.seq ?? 0) + 1)
            return { ok: false, code: "sequence_invalid" };
        if (event.previousEventId !== (previous?.eventId ?? null) ||
            event.previousHash !== (previous?.hash ?? null)) {
            return { ok: false, code: "chain_invalid" };
        }
        const { hash, ...body } = event;
        if ((await digests.sha256Canonical(body)) !== hash)
            return { ok: false, code: "chain_invalid" };
        switch (event.payload.kind) {
            case "run_budget_updated":
                budget = event.payload.budget;
                costUnknown = event.payload.costUnknown;
                break;
            case "run_started":
                state = "active";
                break;
            case "run_cancel_requested":
                break;
            case "run_resumed":
                state = "active";
                safeFailureCode = null;
                break;
            case "run_waiting":
                state = "waiting";
                safeFailureCode = event.payload.safeCode;
                break;
            case "run_completed":
                state = "completed";
                finalText = event.payload.text;
                break;
            case "run_failed":
                state = "failed";
                safeFailureCode = event.payload.safeCode;
                break;
            case "run_cancelled":
                state = "cancelled";
                safeFailureCode = event.payload.safeCode;
                break;
            case "model_request_started":
                modelAttempts += 1;
                break;
            case "tool_execution_finished":
                toolOutcomes[event.payload.toolCallId] = event.payload.status;
                openDispatches.delete(event.payload.toolCallId);
                break;
            case "tool_execution_denied":
                toolOutcomes[event.payload.toolCallId] = "denied";
                openDispatches.delete(event.payload.toolCallId);
                break;
            case "tool_call_cancelled":
                toolOutcomes[event.payload.toolCallId] = "cancelled";
                openDispatches.delete(event.payload.toolCallId);
                break;
            case "model_retry_scheduled":
            case "model_response_validated":
            case "tool_call_received":
            case "approval_requested":
            case "approval_decided":
            case "approval_grant_revoked":
            case "run_input_queued":
            case "run_input_withdrawn":
            case "run_input_batch_consumed":
            case "tool_result_delivery_blocked":
            case "todo_replaced":
            case "tool_execution_started":
                break;
            case "tool_dispatch_committed":
                openDispatches.add(event.payload.toolCallId);
                break;
        }
        previous = event;
    }
    const lastLifecycle = events.findLast((event) => ["run_completed", "run_failed", "run_cancelled", "run_waiting"].includes(event.payload.kind));
    const lastExecution = events.findLast((event) => !["task_report_snapshot", "evidence_unavailable"].includes(event.payload.kind));
    if (lastLifecycle === undefined || lastExecution !== lastLifecycle) {
        return { ok: false, code: "replay_invalid" };
    }
    if (lastLifecycle.payload.kind === "run_completed" && openDispatches.size > 0) {
        return { ok: false, code: "replay_invalid" };
    }
    return {
        ok: true,
        value: {
            state,
            finalText,
            toolOutcomes,
            uncertainDispatches: [...openDispatches],
            modelAttempts,
            safeFailureCode,
            budget,
            costUnknown,
        },
    };
}
