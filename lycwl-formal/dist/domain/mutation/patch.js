/**
 * Unified diff parsing for apply_patch (V1_BEHAVIOR_CONTRACTS section 3).
 * Only per-target hunks are supported: no cross-file global atomicity and no
 * dependency between targets in one batch. Parsing is pure and rejects
 * malformed input instead of guessing.
 */
export const PATCH_LIMITS = Object.freeze({
    maxTargets: 64,
    maxHunksPerTarget: 256,
});
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function parseUnifiedDiff(text) {
    const lines = text.split(/\r\n|\n|\r/);
    const targets = [];
    const seen = new Set();
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (!line.startsWith("--- ")) {
            // Tolerate diff/index/header noise before the first file header.
            if (line.length === 0 || line.startsWith("diff ") || line.startsWith("index ")) {
                index += 1;
                continue;
            }
            return { ok: false, code: "invalid_patch" };
        }
        const oldPath = stripPathPrefix(line.slice(4).trim());
        const next = lines[index + 1] ?? "";
        if (!next.startsWith("+++ "))
            return { ok: false, code: "missing_file_header" };
        const newPath = stripPathPrefix(next.slice(4).trim());
        const path = newPath === "/dev/null" ? oldPath : newPath;
        if (path.length === 0)
            return { ok: false, code: "invalid_patch" };
        if (oldPath === "/dev/null" && newPath === "/dev/null") {
            return { ok: false, code: "invalid_patch" };
        }
        if (seen.has(path))
            return { ok: false, code: "duplicate_target" };
        seen.add(path);
        index += 2;
        const hunks = [];
        while (index < lines.length && !(lines[index] ?? "").startsWith("--- ")) {
            const header = lines[index] ?? "";
            const match = HUNK_HEADER.exec(header);
            if (match === null) {
                if (header.length === 0) {
                    index += 1;
                    continue;
                }
                return { ok: false, code: "invalid_hunk_header" };
            }
            const oldStart = Number(match[1]);
            const oldCount = match[2] === undefined ? 1 : Number(match[2]);
            const newStart = Number(match[3]);
            const newCount = match[4] === undefined ? 1 : Number(match[4]);
            index += 1;
            const body = [];
            let consumedOld = 0;
            let consumedNew = 0;
            while (index < lines.length) {
                const candidate = lines[index] ?? "";
                if (candidate.startsWith("@@") || candidate.startsWith("--- "))
                    break;
                if (candidate.length === 0) {
                    // An empty line is a context line with no prefix; treat as blank context.
                    body.push(" ");
                    consumedOld += 1;
                    consumedNew += 1;
                    index += 1;
                    continue;
                }
                const prefix = candidate[0];
                if (prefix === " ") {
                    consumedOld += 1;
                    consumedNew += 1;
                }
                else if (prefix === "-") {
                    consumedOld += 1;
                }
                else if (prefix === "+") {
                    consumedNew += 1;
                }
                else if (prefix === "\\") {
                    // "\ No newline at end of file" carries no line content.
                    index += 1;
                    continue;
                }
                else {
                    return { ok: false, code: "invalid_hunk_body" };
                }
                body.push(candidate);
                index += 1;
                if (consumedOld === oldCount && consumedNew === newCount)
                    break;
            }
            if (consumedOld !== oldCount || consumedNew !== newCount) {
                return { ok: false, code: "invalid_hunk_body" };
            }
            hunks.push({ oldStart, oldCount, newStart, newCount, lines: body });
            if (hunks.length > PATCH_LIMITS.maxHunksPerTarget) {
                return { ok: false, code: "invalid_patch" };
            }
        }
        if (hunks.length === 0)
            return { ok: false, code: "no_hunks" };
        targets.push({ path, hunks });
        if (targets.length > PATCH_LIMITS.maxTargets) {
            return { ok: false, code: "too_many_targets" };
        }
    }
    if (targets.length === 0)
        return { ok: false, code: "invalid_patch" };
    return { ok: true, targets };
}
function stripPathPrefix(value) {
    let path = value;
    const tab = path.indexOf("\t");
    if (tab !== -1)
        path = path.slice(0, tab);
    if (path === "/dev/null")
        return path;
    if (path.startsWith("a/") || path.startsWith("b/"))
        path = path.slice(2);
    return path;
}
/**
 * Apply hunks to one file's lines. Hunks must not overlap, and every context and
 * removed line must match exactly; otherwise nothing is applied.
 */
export function applyHunks(originalLines, hunks) {
    const ordered = [...hunks].sort((left, right) => left.oldStart - right.oldStart);
    const output = [];
    let cursor = 0;
    for (const hunk of ordered) {
        const startIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
        if (startIndex < cursor)
            return { ok: false, code: "overlapping_hunks" };
        if (startIndex > originalLines.length)
            return { ok: false, code: "hunk_out_of_range" };
        output.push(...originalLines.slice(cursor, startIndex));
        let position = startIndex;
        for (const line of hunk.lines) {
            const prefix = line[0];
            const content = line.slice(1);
            if (prefix === " " || prefix === "-") {
                if (originalLines[position] !== content) {
                    return { ok: false, code: "context_mismatch" };
                }
                if (prefix === " ")
                    output.push(content);
                position += 1;
                continue;
            }
            if (prefix === "+") {
                output.push(content);
            }
        }
        cursor = position;
    }
    output.push(...originalLines.slice(cursor));
    return { ok: true, lines: output };
}
export function splitLines(text) {
    const normalized = text.replace(/\r\n|\r/g, "\n");
    if (normalized.length === 0)
        return [];
    const lines = normalized.split("\n");
    if (lines.at(-1) === "")
        lines.pop();
    return lines;
}
export function joinLines(lines, lineEnding) {
    if (lines.length === 0)
        return "";
    return lines.join(lineEnding) + lineEnding;
}
