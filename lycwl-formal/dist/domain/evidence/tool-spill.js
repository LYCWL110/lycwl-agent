/**
 * Tool output spilling.
 *
 * A tool result larger than the spill threshold is written to a Session attachment
 * and replaced, in model context, with a head and tail preview plus a reference.
 * The model keeps enough to recognize the content and knows where the rest is; the
 * full text stays on disk and is reachable through `read_file`.
 *
 * This is not truncation. Truncation discards the middle permanently, which makes a
 * large result unusable for anything but a summary. Spilling keeps it available.
 *
 * The reference is a workspace-relative path only when the attachment directory is
 * inside the workspace. When it is not, the reference is opaque and the preview says
 * so, because a path the model cannot read would be a false promise.
 */
export const SPILL_LIMITS = Object.freeze({
    /** Below this, the result is small enough to send whole. */
    thresholdUnits: 20_000,
    /** Head kept for recognition. */
    headUnits: 8_000,
    /** Tail kept, because errors and totals are usually at the end. */
    tailUnits: 4_000,
    /** A single preview line longer than this is cut rather than blowing the budget. */
    maxPreviewLineUnits: 2_000,
});
/**
 * Decide whether to spill and build the preview.
 *
 * The preview is deliberately structured rather than a plain cut: the model needs to
 * know the output was complete, how large it was, where the rest is, and how to read
 * it. A bare "...truncated" leaves it unable to tell a complete result from a lost
 * one.
 */
export function spillToolOutput(input) {
    const units = input.text.length;
    if (units <= SPILL_LIMITS.thresholdUnits)
        return { kind: "inline", text: input.text };
    const head = cutAtLine(input.text.slice(0, SPILL_LIMITS.headUnits), "head");
    const cleanTail = cutAtLine(input.text.slice(Math.max(0, units - SPILL_LIMITS.tailUnits)), "tail");
    const preview = [
        `[output spilled: ${units} chars total]`,
        `tool: ${input.toolName}`,
        `full output: ${input.reference}`,
        "read the rest with read_file using the reference above",
        "",
        "--- head ---",
        head,
        "",
        `--- ... ${Math.max(0, units - head.length - cleanTail.length)} chars omitted ... ---`,
        "",
        "--- tail ---",
        cleanTail,
    ].join("\n");
    return { kind: "spilled", preview, reduced: preview.length < units };
}
/**
 * Trim a window to whole lines and cap any single over-long line.
 *
 * The window size is the caller's decision. This only removes a partial first or
 * last line, and bounds a pathological single line (a minified bundle, one-line
 * JSON) so it cannot consume the whole window.
 */
function cutAtLine(window, edge) {
    let text = window;
    if (edge === "tail") {
        // A tail window starts mid-line; that fragment is not content.
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1)
            text = text.slice(firstNewline + 1);
    }
    else {
        // A head window may end mid-line; drop the fragment.
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline !== -1)
            text = text.slice(0, lastNewline);
    }
    return text
        .split("\n")
        .map((line) => line.length <= SPILL_LIMITS.maxPreviewLineUnits
        ? line
        : `${line.slice(0, SPILL_LIMITS.maxPreviewLineUnits)}[line truncated]`)
        .join("\n");
}
/**
 * Whether a result should be spilled before it is even built.
 *
 * A tool that knows its output is going to be enormous can ask this to avoid
 * materializing a string it will immediately replace. It is advisory: the actual
 * decision is made on the text that exists.
 */
export function exceedsSpillThreshold(length) {
    return length > SPILL_LIMITS.thresholdUnits;
}
