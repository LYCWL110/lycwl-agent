import { buildReportSnapshot, } from "../../domain/evidence/verification.js";
/**
 * Only trusted facts establish execution/evidence status. No command-name guess
 * makes a Shell invocation a test, and model completion prose cannot verify the
 * user's goal. Later independent check observations can add goal assertions.
 */
export function deriveTaskReport(events, sessionId, runId) {
    const facts = events.filter((event) => event.sessionId === sessionId && event.runId === runId);
    const started = facts.find((event) => event.payload.kind === "run_started");
    if (started?.payload.kind !== "run_started")
        return { ok: false, code: "missing_required_field", detail: "run_started" };
    const toolNames = new Map();
    const openDispatches = new Set();
    const unknown = new Set();
    const unavailable = [];
    let latestChange = null;
    let view = "progress";
    let wait = null;
    let knownUsd = 0;
    let attempts = 0;
    /**
     * Requests whose token cost is unknown.
     *
     * Counted from the responses themselves, not from a blanket flag: a request whose
     * provider reported usage has a known token count, and only the ones that did not
     * are unknown. The previous rule marked every request unknown because no usage was
     * ever captured.
     */
    let unpricedAttempts = 0;
    let costUnknown = false;
    const approved = new Set();
    const background = new Map();
    for (const event of facts) {
        const fact = event.payload;
        switch (fact.kind) {
            case "run_input_queued":
                latestChange = fact.text;
                break;
            case "tool_call_received":
                toolNames.set(fact.toolCallId, fact.toolName);
                break;
            case "approval_decided":
                if (fact.decision === "approved")
                    approved.add(fact.toolCallId);
                wait = null;
                view = "progress";
                break;
            case "tool_dispatch_committed":
                openDispatches.add(fact.toolCallId);
                view = "progress";
                wait = null;
                break;
            case "background_task_observed":
                background.set(fact.task.taskId, fact.task.state);
                if (fact.task.state === "outcome_unknown")
                    unknown.add(fact.task.processExecutionId);
                if ("evidence" in fact.task && fact.task.evidence?.rawComplete === false)
                    unavailable.push({
                        ref: eventRef(event),
                        reason: fact.task.evidence.rawTruncationReason === "blocked"
                            ? "content_not_stored"
                            : "capture_truncated",
                    });
                break;
            case "tool_execution_finished":
                openDispatches.delete(fact.toolCallId);
                if (fact.status === "outcome_unknown")
                    unknown.add(fact.toolCallId);
                if (fact.evidence !== undefined && !fact.evidence.rawComplete) {
                    unavailable.push({
                        ref: eventRef(event),
                        reason: fact.evidence.rawTruncationReason === "blocked"
                            ? "content_not_stored"
                            : "capture_truncated",
                    });
                }
                break;
            case "evidence_unavailable":
                unavailable.push({ ref: fact.ref, reason: fact.reason });
                break;
            case "model_request_started":
                attempts++;
                break;
            case "model_response_validated":
                // No usage on a validated response means the provider did not report one.
                if (fact.usage === undefined)
                    unpricedAttempts++;
                break;
            case "run_budget_updated":
                knownUsd = fact.budget.knownSpendingUsd;
                costUnknown = fact.costUnknown;
                break;
            case "run_waiting":
                view = "waiting";
                wait = {
                    reason: fact.reason,
                    waitToken: fact.waitToken,
                    requiredAction: fact.safeCode === "sensitive_disclosure_required"
                        ? "disclosure_consent"
                        : fact.reason === "approval"
                            ? "reply_approval"
                            : fact.reason === "user_input"
                                ? "submit_user_input"
                                : "resume_run",
                };
                break;
            case "sensitive_disclosure_requested":
                view = "waiting";
                wait = {
                    reason: "sensitive_disclosure",
                    waitToken: fact.disclosureId,
                    requiredAction: "disclosure_consent",
                };
                break;
            case "sensitive_disclosure_decided":
            case "question_answered":
            case "question_declined":
            case "question_cancelled":
            case "run_resumed":
                wait = null;
                view = "progress";
                break;
            case "run_completed":
            case "run_failed":
            case "run_cancelled":
                view = "terminal";
                wait = null;
                break;
        }
    }
    for (const id of openDispatches)
        unknown.add(id);
    return buildReportSnapshot({
        sessionId,
        runId,
        sourceHighWaterSeq: events.at(-1)?.seq ?? 0,
        projectionVersion: "internal-facts-1",
        generatorVersion: "conservative-report-1",
        view,
        userGoal: started.payload.input,
        latestChange,
        assertions: [
            {
                assertionId: `${runId}:goal`,
                kind: "required_goal",
                description: started.payload.input,
                state: "unknown",
                applicability: unknown.size === 0 ? "current" : "indeterminate",
                evidence: [],
                unavailableEvidence: unavailable,
                required: true,
            },
        ],
        // A command may modify arbitrary files; absent typed observations is not a
        // complete change list. Likewise, no independently classified tests exist.
        changes: [],
        tests: [],
        unknownSideEffects: [...unknown].map((id) => `${toolNames.get(id) ?? "tool"}:${id}${approved.has(id) ? ":approved" : ""}`),
        backgroundTasks: [...background].map(([taskId, state]) => ({ taskId, state })),
        wait,
        nextUserActions: wait === null ? [] : [wait.requiredAction],
        usage: {
            knownUsd,
            // Counted from the responses: a request that reported tokens is not an unknown
            // charge even though no price table exists yet. The flag is retained for the
            // case where the run ended before any response settled the question.
            unknownChargeCount: unpricedAttempts > 0 ? unpricedAttempts : costUnknown && attempts > 0 ? attempts : 0,
        },
    });
}
function eventRef(event) {
    return { kind: "event", sessionId: event.sessionId, eventId: event.eventId, seq: event.seq };
}
