import { isPosixPath } from "../path/platform-path.js";
/**
 * Workspace project-guidance discovery (ADR-0014 / V1_BEHAVIOR_CONTRACTS
 * supplement A).
 *
 * Rules this module owns:
 * - only `AGENTS.md`, matched case-insensitively on Windows;
 * - from the workspace root down to the directory containing the target, in that
 *   order, so ancestors apply before descendants;
 * - a directory's own `AGENTS.md` applies to that directory;
 * - no repository-wide scan, no ancestors outside the workspace, no fallback to
 *   `README.md`, `CLAUDE.md` or any other filename;
 * - deduplication by resolved identity plus content hash, not by name.
 *
 * This module decides *which* candidates apply. Reading them is an ordinary read
 * and stays subject to the normal path, sensitive-file and budget rules.
 */
export const PROJECT_GUIDANCE_FILENAME = "AGENTS.md";
export const PROJECT_GUIDANCE_LIMITS = Object.freeze({
    /** Raw bytes allowed for a single guidance file. */
    maxFileBytes: 64 * 1024,
    /** Raw bytes allowed for all guidance currently applicable to one target. */
    maxTotalBytes: 256 * 1024,
    /** Directory depth bound so a pathological tree cannot produce an unbounded list. */
    maxDepth: 64,
});
/**
 * Compute the candidate `AGENTS.md` paths for a target path.
 *
 * `existingNames` is the set of entry names that actually exist in each
 * directory, as reported by the caller. This function does not touch the
 * filesystem: discovery is a pure computation over observed directory listings,
 * so it cannot accidentally cause extra reads.
 */
export function discoverProjectGuidance(input) {
    const root = normalizeWindowsPath(input.workspaceRoot);
    if (root === null)
        return { ok: false, code: "invalid_workspace_root" };
    const target = normalizeWindowsPath(input.targetPath);
    if (target === null)
        return { ok: false, code: "invalid_target_path" };
    const rootSegments = splitAbsolute(root);
    const targetSegments = splitAbsolute(target);
    if (rootSegments === null || targetSegments === null) {
        return { ok: false, code: "invalid_target_path" };
    }
    const rootKey = pathKey(root);
    const targetKey = pathKey(target);
    const posix = isPosixPath(root);
    const separator = posix ? "/" : "\\";
    if (targetKey !== rootKey &&
        !targetKey.startsWith(rootKey === "/" ? "/" : `${rootKey}${separator}`)) {
        return { ok: false, code: "target_outside_workspace" };
    }
    // The target's directory is the last directory to check. For a directory
    // target that is the directory itself; for a file target it is the parent.
    const targetDirectory = input.targetIsDirectory ? target : parentOf(target);
    const relative = relativeSegments(root, targetDirectory);
    if (relative === null)
        return { ok: false, code: "target_outside_workspace" };
    if (relative.length > PROJECT_GUIDANCE_LIMITS.maxDepth) {
        return { ok: false, code: "too_deep" };
    }
    const candidates = [];
    const seenIdentities = new Set();
    for (let depth = 0; depth <= relative.length; depth += 1) {
        const directory = joinSegments(root, relative.slice(0, depth));
        const names = input.entriesFor(directory);
        const matches = names.filter((name) => posix
            ? name === PROJECT_GUIDANCE_FILENAME
            : name.toLowerCase() === PROJECT_GUIDANCE_FILENAME.toLowerCase());
        // On a case-sensitive volume two distinct entries could both match; picking
        // one arbitrarily would be a silent trust decision, so this fails instead.
        if (matches.length > 1) {
            return { ok: false, code: "case_ambiguous_candidates" };
        }
        const match = matches[0];
        if (match === undefined)
            continue;
        const candidatePath = joinSegments(directory, [match]);
        const identity = pathKey(candidatePath);
        if (seenIdentities.has(identity))
            continue;
        seenIdentities.add(identity);
        candidates.push({ directory, path: candidatePath, depth });
    }
    return { ok: true, candidates };
}
/**
 * Order is already deterministic (root to target). This helper exists so callers
 * do not re-sort and accidentally invert precedence.
 */
export function guidanceApplicationOrder(candidates) {
    return [...candidates].sort((left, right) => left.depth - right.depth);
}
/**
 * Check the confirmed per-file and total byte bounds *before* injecting anything.
 * Over-budget guidance is an explicit capacity error, never a silently truncated
 * "complete rules" payload.
 */
export function checkGuidanceBudget(sizes) {
    let total = 0;
    for (const size of sizes) {
        if (!Number.isSafeInteger(size) || size < 0)
            return { ok: false, code: "invalid_size" };
        if (size > PROJECT_GUIDANCE_LIMITS.maxFileBytes) {
            return { ok: false, code: "file_too_large" };
        }
        total += size;
        // Checked per step so a large set cannot overflow before the final compare.
        if (total > PROJECT_GUIDANCE_LIMITS.maxTotalBytes) {
            return { ok: false, code: "total_too_large" };
        }
    }
    return { ok: true };
}
function normalizeWindowsPath(value) {
    if (isPosixPath(value)) {
        const segments = [];
        for (const segment of value.split("/")) {
            if (!segment || segment === ".")
                continue;
            if (segment === "..")
                segments.pop();
            else
                segments.push(segment);
        }
        return `/${segments.join("/")}`;
    }
    if (value.length === 0)
        return null;
    const replaced = value.replace(/\//g, "\\");
    if (!/^[A-Za-z]:\\/.test(replaced) && !replaced.startsWith("\\\\"))
        return null;
    return replaced.replace(/\\+$/, "");
}
function splitAbsolute(value) {
    if (isPosixPath(value))
        return value.split("/").filter(Boolean);
    if (value.startsWith("\\\\")) {
        const parts = value
            .slice(2)
            .split("\\")
            .filter((part) => part.length > 0);
        return parts.length === 0 ? null : parts;
    }
    if (!/^[A-Za-z]:$/.test(value.slice(0, 2)))
        return null;
    const rest = value
        .slice(2)
        .split("\\")
        .filter((part) => part.length > 0);
    return [`${value.slice(0, 2).toUpperCase()}`, ...rest];
}
function pathKey(value) {
    if (isPosixPath(value))
        return value;
    return value.replace(/\//g, "\\").toLowerCase();
}
function relativeSegments(root, target) {
    if (isPosixPath(root)) {
        if (target === root)
            return [];
        const prefix = root === "/" ? "/" : `${root}/`;
        return target.startsWith(prefix)
            ? target.slice(prefix.length).split("/").filter(Boolean)
            : null;
    }
    const rootKey = pathKey(root);
    const targetKey = pathKey(target);
    if (targetKey === rootKey)
        return [];
    if (!targetKey.startsWith(`${rootKey}\\`))
        return null;
    return target
        .slice(root.length + 1)
        .split("\\")
        .filter((part) => part.length > 0);
}
function parentOf(value) {
    if (isPosixPath(value))
        return value.slice(0, value.lastIndexOf("/")) || "/";
    const index = value.lastIndexOf("\\");
    if (index <= 0)
        return value;
    // Keep the drive root form `C:\` intact.
    if (index === 2 && /^[A-Za-z]:\\/.test(value))
        return value.slice(0, 3);
    return value.slice(0, index);
}
function joinSegments(base, segments) {
    if (isPosixPath(base))
        return segments.length ? `${base === "/" ? "" : base}/${segments.join("/")}` : base;
    if (segments.length === 0)
        return base;
    const separator = base.endsWith("\\") ? "" : "\\";
    return `${base}${separator}${segments.join("\\")}`;
}
