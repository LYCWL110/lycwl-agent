/**
 * Session Todo list (ADR-0021 / V1_BEHAVIOR_CONTRACTS section 2.4). Whole-list
 * replacement, bounded items, four planning states with at most one in_progress.
 * Todo state is planning state only: it is not verification evidence and grants
 * no execution authority.
 */
export const TODO_LIMITS = Object.freeze({
    maxItems: 100,
    maxContentCodePoints: 500,
});
export const TODO_STATES = ["pending", "in_progress", "completed", "cancelled"];
export function emptyTodoList() {
    return { items: [], revision: 0 };
}
/**
 * Replace the whole visible list. IDs must stay unique and stable across
 * updates; the previous revision is preserved in history, never rewritten.
 */
export function replaceTodoList(previous, input) {
    if (!Array.isArray(input))
        return { ok: false, code: "invalid_list" };
    if (input.length > TODO_LIMITS.maxItems)
        return { ok: false, code: "too_many_items" };
    const ids = new Set();
    const items = [];
    let inProgress = 0;
    for (const raw of input) {
        if (typeof raw !== "object" || raw === null)
            return { ok: false, code: "invalid_list" };
        const record = raw;
        const id = record["id"];
        if (typeof id !== "string")
            return { ok: false, code: "invalid_list" };
        if (id.length === 0)
            return { ok: false, code: "empty_id" };
        if (ids.has(id))
            return { ok: false, code: "duplicate_id" };
        ids.add(id);
        const content = record["content"];
        if (typeof content !== "string")
            return { ok: false, code: "invalid_list" };
        if (content.trim().length === 0)
            return { ok: false, code: "empty_content" };
        if ([...content].length > TODO_LIMITS.maxContentCodePoints) {
            return { ok: false, code: "content_too_long" };
        }
        const state = record["state"];
        if (typeof state !== "string" || !TODO_STATES.includes(state)) {
            return { ok: false, code: "invalid_state" };
        }
        if (state === "in_progress")
            inProgress += 1;
        items.push({ id, content, state: state });
    }
    if (inProgress > 1)
        return { ok: false, code: "multiple_in_progress" };
    return { ok: true, value: { items, revision: previous.revision + 1 } };
}
/**
 * Completed and cancelled items are retained in the list; only an explicit
 * empty list clears it. This is a planning fact, not proof the work was done.
 */
export function todoCounts(list) {
    const counts = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0,
    };
    for (const item of list.items)
        counts[item.state] += 1;
    return counts;
}
export function describeTodoList(list) {
    const counts = todoCounts(list);
    return [
        `todo: ${list.items.length} item(s) revision=${list.revision}`,
        `pending=${counts.pending} in_progress=${counts.in_progress} completed=${counts.completed} cancelled=${counts.cancelled}`,
        ...list.items.map((item) => `[${item.state}] ${item.id}: ${item.content}`),
    ].join("\n");
}
