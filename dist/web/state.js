/** Build the complete snapshot the browser applies wholesale. */
export function toWebState(input) {
    const { session, view, sessionList, switching } = input;
    return {
        sessionId: session.sessionId,
        modelLabel: session.modelLabel,
        modeLabel: session.modeLabel,
        contextWindow: session.contextWindow,
        demo: session.demo,
        warnings: session.warnings,
        switching,
        runStatus: view.runStatus,
        waitingKind: view.waitingKind,
        activity: view.activity,
        streaming: view.streaming ?? null,
        transcript: view.transcript,
        todo: view.todo,
        meter: view.meter,
        usage: view.usage ?? null,
        safeCode: view.safeCode,
        answerError: view.answerError,
        commandNotice: view.commandNotice ?? null,
        pendingApproval: view.pendingApproval,
        pendingApprovalPreview: view.pendingApprovalPreview,
        pendingDisclosure: view.pendingDisclosure ?? null,
        pendingQuestion: view.pendingQuestion,
        canSubmit: view.canSubmit,
        queueingInput: view.queueingInput,
        sessionList,
    };
}
