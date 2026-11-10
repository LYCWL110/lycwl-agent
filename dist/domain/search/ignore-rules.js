export function parseIgnoreRule(source, basePath, line) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length === 0)
        return null;
    if (trimmed.startsWith("#"))
        return null;
    const negated = trimmed.startsWith("!");
    const body = negated ? trimmed.slice(1) : trimmed;
    if (body.length === 0)
        return null;
    const directoryOnly = body.endsWith("/");
    const withoutTrailing = directoryOnly ? body.slice(0, -1) : body;
    const anchored = withoutTrailing.includes("/");
    return {
        source,
        basePath: basePath.replace(/\\/g, "/").replace(/\/+$/, ""),
        pattern: withoutTrailing,
        negated,
        directoryOnly,
        anchored,
    };
}
export function parseIgnoreFile(source, basePath, content) {
    const rules = [];
    for (const line of content.split("\n")) {
        const rule = parseIgnoreRule(source, basePath, line);
        if (rule !== null)
            rules.push(rule);
    }
    return rules;
}
const IGNORED = { ignored: true, reason: "none", rule: null };
const KEPT = { ignored: false, reason: "none", rule: null };
/**
 * Evaluate one path against a rule set. Deeper base paths and later rules in the
 * same source take precedence; `.ignore` outranks `.gitignore` at equal depth.
 */
export function evaluateIgnore(rules, path) {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalized.split("/").filter((part) => part.length > 0);
    let best = null;
    rules.forEach((rule, index) => {
        if (!matchesRule(rule, normalized, segments))
            return;
        const depth = rule.basePath.length === 0 ? 0 : rule.basePath.split("/").length;
        const sourceRank = rule.source === ".ignore" ? 1 : 0;
        if (best === null ||
            depth > best.depth ||
            (depth === best.depth && sourceRank > best.sourceRank) ||
            (depth === best.depth && sourceRank === best.sourceRank && index > best.index)) {
            best = { rule, depth, index, sourceRank };
        }
    });
    if (best === null)
        return KEPT;
    const winner = best;
    return {
        ignored: !winner.rule.negated,
        reason: winner.rule.source === ".ignore" ? "ignore_file" : "gitignore_file",
        rule: winner.rule,
    };
}
/**
 * A path stays excluded when any ancestor directory is ignored, even if a later
 * negation names the file itself.
 */
export function evaluateIgnoreWithAncestors(rules, path) {
    const segments = path
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .split("/")
        .filter((part) => part.length > 0);
    for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join("/");
        const verdict = evaluateIgnore(rules, ancestor);
        if (verdict.ignored)
            return verdict;
    }
    return evaluateIgnore(rules, path);
}
function matchesRule(rule, path, segments) {
    const base = rule.basePath;
    let relative = path;
    if (base.length > 0) {
        if (path === base)
            return false;
        if (!path.startsWith(`${base}/`))
            return false;
        relative = path.slice(base.length + 1);
    }
    const pattern = rule.pattern.replace(/^\/+/, "");
    if (rule.anchored) {
        return matchPattern(pattern, relative, rule.directoryOnly);
    }
    if (matchPattern(pattern, relative, rule.directoryOnly))
        return true;
    for (let index = 0; index < segments.length; index += 1) {
        const suffix = segments.slice(index).join("/");
        if (matchPattern(pattern, suffix, rule.directoryOnly))
            return true;
    }
    return false;
}
function matchPattern(pattern, candidate, directoryOnly) {
    const target = directoryOnly ? candidate : candidate;
    const regex = new RegExp(`^${globToRegex(pattern)}$`);
    if (regex.test(target))
        return true;
    if (directoryOnly)
        return regex.test(`${target}/`);
    return false;
}
function globToRegex(pattern) {
    let output = "";
    let index = 0;
    while (index < pattern.length) {
        const character = pattern[index] ?? "";
        if (character === "*") {
            if (pattern[index + 1] === "*") {
                const following = pattern[index + 2];
                output += following === "/" ? "(?:.*/)?" : ".*";
                index += following === "/" ? 3 : 2;
                continue;
            }
            output += "[^/]*";
            index += 1;
            continue;
        }
        if (character === "?") {
            output += "[^/]";
            index += 1;
            continue;
        }
        output += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        index += 1;
    }
    return output;
}
export const IGNORED_VERDICT = IGNORED;
export const KEPT_VERDICT = KEPT;
