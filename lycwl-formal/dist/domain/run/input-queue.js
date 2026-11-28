/**
 * Ordinary supplementary Run input queue (ADR-0014 / behavior supplement B).
 * Queue arrival is never authorization: consuming input only updates the task
 * context and supersedes undispatched calls; it cannot approve anything.
 */
export const RUN_INPUT_LIMITS = Object.freeze({
    maxItemUtf16Units: 16_000,
    maxPendingItems: 16,
    maxPendingUtf16Units: 128_000,
});
export function emptyRunInputQueue() {
    return { items: [], handledCommandIds: {} };
}
export function utf16Units(text) {
    return text.length;
}
export function queueRunInput(queue, command) {
    if (command.commandId.length === 0 || command.inputId.length === 0) {
        return { ok: false, code: "invalid_identity" };
    }
    if (command.text.trim().length === 0)
        return { ok: false, code: "invalid_text" };
    const handled = queue.handledCommandIds[command.commandId];
    if (handled !== undefined) {
        return handled === command.inputId
            ? { ok: true, queue, duplicate: true }
            : { ok: false, code: "invalid_identity" };
    }
    if (command.runState === "completed" ||
        command.runState === "failed" ||
        command.runState === "cancelled") {
        return { ok: false, code: "run_terminal" };
    }
    if (utf16Units(command.text) > RUN_INPUT_LIMITS.maxItemUtf16Units) {
        return { ok: false, code: "input_too_long" };
    }
    if (queue.items.length >= RUN_INPUT_LIMITS.maxPendingItems) {
        return { ok: false, code: "queue_full" };
    }
    const last = queue.items.at(-1);
    if (last !== undefined && command.acceptedSeq <= last.acceptedSeq) {
        return { ok: false, code: "sequence_not_increasing" };
    }
    const pendingUnits = queue.items.reduce((total, item) => total + utf16Units(item.text), 0);
    if (pendingUnits + utf16Units(command.text) > RUN_INPUT_LIMITS.maxPendingUtf16Units) {
        return { ok: false, code: "queue_units_exceeded" };
    }
    return {
        ok: true,
        duplicate: false,
        queue: {
            items: [
                ...queue.items,
                { inputId: command.inputId, text: command.text, acceptedSeq: command.acceptedSeq },
            ],
            handledCommandIds: { ...queue.handledCommandIds, [command.commandId]: command.inputId },
        },
    };
}
export function consumeRunInput(queue, throughSeq, taskRevision) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
        return { ok: false, code: "invalid_high_water" };
    }
    if (!Number.isSafeInteger(taskRevision) || taskRevision < 1) {
        return { ok: false, code: "invalid_high_water" };
    }
    const consumed = queue.items.filter((item) => item.acceptedSeq <= throughSeq);
    if (consumed.length === 0)
        return { ok: false, code: "empty_batch" };
    return {
        ok: true,
        queue: {
            items: queue.items.filter((item) => item.acceptedSeq > throughSeq),
            handledCommandIds: queue.handledCommandIds,
        },
        batch: {
            inputIds: consumed.map((item) => item.inputId),
            throughSeq,
            taskRevision,
        },
    };
}
/**
 * Withdraw only an unconsumed input. A consumed or sent input cannot be
 * pretended away; the user must add a new message instead.
 */
export function withdrawRunInput(queue, inputId) {
    if (!queue.items.some((item) => item.inputId === inputId)) {
        return { ok: false, code: "unknown_input" };
    }
    return {
        ok: true,
        queue: {
            items: queue.items.filter((item) => item.inputId !== inputId),
            handledCommandIds: queue.handledCommandIds,
        },
    };
}
