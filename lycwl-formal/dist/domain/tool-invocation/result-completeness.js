/**
 * Completeness of a tool result, separate from whether execution succeeded.
 *
 * `status` answers "did the call finish normally". `outcome` answers "is what the
 * model received the whole result". They are independent:
 *
 * | Situation | status | outcome |
 * | --- | --- | --- |
 * | Query returned every row | succeeded | complete |
 * | Query returned 20 of 138 rows | succeeded | partial |
 * | Output exceeded the model budget | succeeded | partial |
 * | Payment timed out | outcome_unknown | unconfirmed |
 * | Confirmed failure | failed | (absent) |
 *
 * Before this, partiality lived only in the text as `[truncated: model budget]`.
 * The model had to read a marker to learn that more data existed, and a marker is
 * prose rather than a fact: it can be paraphrased away, and a result with no marker
 * is indistinguishable from one where the marker was lost.
 *
 * `unconfirmed` exists because `outcome_unknown` is not a failure. The operation may
 * have happened; the Harness simply cannot say. Reporting `partial` there would
 * claim knowledge nobody has.
 */
/** A complete result. */
export const COMPLETE = { outcome: "complete" };
/** A result cut by the model-facing budget. */
export function truncatedForBudget() {
    return {
        outcome: "partial",
        reason: "model_budget",
        continuation: "Read the stored output with read_file, or narrow the request.",
    };
}
/** A result limited by the tool's own paging. */
export function limitedByPage(continuation) {
    return { outcome: "partial", reason: "page_limit", continuation };
}
/** A result replaced by a preview pointing at the stored copy. */
export function spilledResult(reference) {
    return {
        outcome: "partial",
        reason: "spilled",
        continuation: `Read the full output from ${reference}.`,
    };
}
/** An operation whose effect could not be established. */
export function unconfirmed() {
    return { outcome: "unconfirmed", reason: "unverified" };
}
/**
 * Whether the model can act on the result as a final answer.
 *
 * A partial result may still be useful, so this is not a failure test: it says
 * whether the model should consider looking for more.
 */
export function needsContinuation(completeness) {
    return completeness.outcome !== "complete";
}
/**
 * Render the completeness as a single line for the tool result.
 *
 * It is appended to the text so a model reading only the text still learns the
 * fact, while the structured field carries it for anything that reads the event.
 * Both are needed: the text is what the model sees, the field is what the Harness
 * and its reports can reason about.
 */
export function describeCompleteness(completeness) {
    if (completeness.outcome === "complete")
        return null;
    const reason = completeness.reason === "model_budget"
        ? "cut to fit the token budget"
        : completeness.reason === "page_limit"
            ? "limited by the tool's page size"
            : completeness.reason === "spilled"
                ? "stored in full, preview shown"
                : completeness.reason === "unverified"
                    ? "the effect could not be verified"
                    : "not complete";
    const head = completeness.outcome === "partial" ? `[partial: ${reason}]` : `[unconfirmed: ${reason}]`;
    return completeness.continuation === undefined ? head : `${head}\n${completeness.continuation}`;
}
/**
 * Merge completeness from several stages of one call.
 *
 * The most severe wins: an unconfirmed result stays unconfirmed even if a later
 * stage would have marked it partial, because the unknown is the stronger statement.
 * Among partials the first reason is kept, since it is the one that caused the cut.
 */
export function mergeCompleteness(left, right) {
    if (left.outcome === "unconfirmed")
        return left;
    if (right.outcome === "unconfirmed")
        return right;
    if (left.outcome === "partial")
        return left;
    return right;
}
