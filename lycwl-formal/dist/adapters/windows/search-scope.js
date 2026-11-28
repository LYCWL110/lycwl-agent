import path from "node:path";
import ignore, {} from "ignore";
import { isPosixWorkspaceRoot } from "../../services/permission/posix-workspace-path.js";
import { decideResolvedReadPermission } from "../../services/permission/resolved-read-policy.js";
import { classifySensitiveRead, resolveWorkspacePath, } from "../../services/permission/workspace-path.js";
/** One snapshot of ignore rules and scope facts per search invocation. */
export function createSearchScope(workspaceRoot, reader, fs) {
    const rules = new Map();
    const ignored = new Set();
    const skipped = new Set();
    const unavailable = new Set();
    let incomplete = false;
    async function load(directory) {
        if (rules.has(directory))
            return;
        const entry = {
            git: ignore({ ignorecase: !isPosixWorkspaceRoot(workspaceRoot) }),
            ordinary: ignore({ ignorecase: !isPosixWorkspaceRoot(workspaceRoot) }),
        };
        for (const [name, matcher] of [
            [".gitignore", entry.git],
            [".ignore", entry.ordinary],
        ]) {
            const target = directory === "" ? name : `${directory}/${name}`;
            const inspected = await fs.inspect(target);
            if (!inspected.ok) {
                if (inspected.code !== "not_found") {
                    incomplete = true;
                    skipped.add(directory || ".");
                    unavailable.add(directory);
                }
                continue;
            }
            if (decideResolvedReadPermission(workspaceRoot, inspected.target).outcome !== "allowed") {
                incomplete = true;
                skipped.add(directory || ".");
                unavailable.add(directory);
                continue;
            }
            const content = await reader.readText(target);
            if (content === null) {
                incomplete = true;
                skipped.add(directory || ".");
                unavailable.add(directory);
                continue;
            }
            try {
                matcher.add(content);
            }
            catch {
                incomplete = true;
                skipped.add(directory || ".");
                unavailable.add(directory);
            }
        }
        rules.set(directory, entry);
    }
    async function isIgnored(candidate, isDirectory) {
        const segments = candidate.split("/");
        for (let length = 1; length <= segments.length; length += 1) {
            let excluded = false;
            for (const source of ["git", "ordinary"]) {
                for (let depth = 0; depth < length; depth += 1) {
                    const base = segments.slice(0, depth).join("/");
                    await load(base);
                    if (unavailable.has(base))
                        throw new Error("ignore_rules_unavailable");
                    const relative = segments.slice(depth, length).join("/") +
                        (length < segments.length || isDirectory ? "/" : "");
                    const matcher = rules.get(base);
                    if (matcher === undefined)
                        throw new Error("ignore_rules_unavailable");
                    const verdict = matcher[source].test(relative);
                    if (verdict.ignored)
                        excluded = true;
                    else if (verdict.unignored)
                        excluded = false;
                }
            }
            if (excluded)
                return true;
        }
        return false;
    }
    return {
        begin() {
            rules.clear();
            ignored.clear();
            skipped.clear();
            unavailable.clear();
            incomplete = false;
        },
        facts() {
            return {
                ignoredPaths: [...ignored],
                skippedPaths: [...skipped],
                unsearchedPaths: [...unavailable].map((entry) => entry || "."),
                ignoreRulesIncomplete: incomplete,
            };
        },
        async listEntries(directory) {
            const supplied = resolveWorkspacePath(workspaceRoot, directory || ".");
            if (!supplied.ok || !supplied.value.withinWorkspace)
                throw new Error("invalid_path");
            const nativeRelative = path.relative(workspaceRoot, supplied.value.absolutePath);
            const relative = isPosixWorkspaceRoot(workspaceRoot)
                ? nativeRelative
                : nativeRelative.replaceAll("\\", "/");
            const inspected = await fs.inspect(directory || ".");
            const resolved = inspected.ok
                ? resolveWorkspacePath(workspaceRoot, inspected.target.resolvedPath)
                : null;
            if (!inspected.ok ||
                classifySensitiveRead({ absolutePath: supplied.value.absolutePath, isDirectory: true }) !==
                    null ||
                classifySensitiveRead({
                    absolutePath: inspected.target.resolvedPath,
                    isDirectory: true,
                }) !== null ||
                resolved === null ||
                !resolved.ok ||
                !resolved.value.withinWorkspace) {
                skipped.add(relative || ".");
                return [];
            }
            if (relative !== "" && (await isIgnored(relative, true))) {
                ignored.add(relative);
                return [];
            }
            await load(relative);
            if (unavailable.has(relative))
                return [];
            const listed = await reader.listDirectory(directory);
            if (!listed.ok)
                throw new Error(listed.code);
            const entries = [];
            for (const entry of listed.entries) {
                if (await isIgnored(entry.path, entry.kind === "directory")) {
                    ignored.add(entry.path);
                    continue;
                }
                const target = await fs.inspect(entry.path);
                const suppliedEntry = resolveWorkspacePath(workspaceRoot, entry.path);
                if (!target.ok ||
                    !suppliedEntry.ok ||
                    entry.isReparse ||
                    classifySensitiveRead({
                        absolutePath: suppliedEntry.value.absolutePath,
                        isDirectory: entry.kind === "directory",
                    }) !== null ||
                    classifySensitiveRead({
                        absolutePath: target.target.resolvedPath,
                        isDirectory: entry.kind === "directory",
                    }) !== null) {
                    skipped.add(entry.path);
                    continue;
                }
                entries.push(entry);
            }
            return entries;
        },
        async readText(file) {
            const inspected = await fs.inspect(file);
            if (!inspected.ok ||
                decideResolvedReadPermission(workspaceRoot, inspected.target).outcome !== "allowed") {
                skipped.add(file);
                throw new Error("approval_required");
            }
            const text = await reader.readText(file);
            if (text === null)
                throw new Error("read_failed");
            const after = await fs.inspect(file);
            if (!after.ok ||
                inspected.snapshot.identity !== after.snapshot.identity ||
                inspected.snapshot.lastWriteTimeNs !== after.snapshot.lastWriteTimeNs ||
                inspected.snapshot.size !== after.snapshot.size)
                throw new Error("file_changed");
            return text;
        },
    };
}
