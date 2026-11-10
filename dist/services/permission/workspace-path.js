const RESERVED_BASENAMES = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
]);
const PROTECTED_DIRECTORIES = new Set([".git", ".vscode", ".idea", ".claude"]);
const SENSITIVE_FILES = new Set([
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
    ".claude.json",
]);
export function resolveWorkspacePath(workspaceRoot, requestedPath) {
    if (workspaceRoot.length === 0 || requestedPath.length === 0) {
        return { ok: false, code: "empty_path" };
    }
    if (hasControlCharacter(workspaceRoot) || hasControlCharacter(requestedPath)) {
        return { ok: false, code: "control_character" };
    }
    const root = normalizeAbsolutePath(workspaceRoot);
    if (!root.ok)
        return root;
    const normalizedRoot = root.value;
    const isDirectory = /[\\/]$/.test(requestedPath);
    if (isDeviceNamespace(requestedPath))
        return { ok: false, code: "device_namespace" };
    const supplied = normalizeAbsolutePath(isAbsoluteWindowsPath(requestedPath)
        ? requestedPath
        : joinRootAndRelative(normalizedRoot, requestedPath));
    if (!supplied.ok)
        return supplied;
    const absolutePath = supplied.value;
    return {
        ok: true,
        value: {
            absolutePath,
            workspaceRoot: normalizedRoot,
            withinWorkspace: isSameOrChild(normalizedRoot, absolutePath),
            isDirectory,
        },
    };
}
export function classifySensitiveRead(path) {
    const segments = splitPath(path.absolutePath);
    const basename = segments.at(-1) ?? "";
    const lowerBasename = basename.toLowerCase();
    if (segments.some((segment) => PROTECTED_DIRECTORIES.has(segment.toLowerCase()))) {
        return "protected_directory";
    }
    if (lowerBasename === ".env" ||
        (lowerBasename.startsWith(".env.") &&
            lowerBasename !== ".env.example" &&
            lowerBasename !== ".env.sample" &&
            lowerBasename !== ".env.template")) {
        return "environment_file";
    }
    if (SENSITIVE_FILES.has(lowerBasename))
        return "sensitive_file";
    return null;
}
function hasControlCharacter(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f)
            return true;
    }
    return false;
}
function isDeviceNamespace(value) {
    return value.startsWith("\\\\.\\") || value.startsWith("\\\\?\\");
}
function isAbsoluteWindowsPath(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
function joinRootAndRelative(root, relative) {
    const separator = root.endsWith("\\") ? "" : "\\";
    return `${root}${separator}${relative.replace(/^[\\/]+/, "")}`;
}
function normalizeAbsolutePath(value) {
    let candidate = value.replace(/\//g, "\\");
    let prefix = "";
    if (candidate.startsWith("\\\\")) {
        const remainder = candidate.slice(2);
        const parts = remainder.split("\\").filter((part) => part.length > 0);
        if (parts.length < 2)
            return { ok: false, code: "invalid_unc" };
        prefix = `\\\\${parts[0]}\\${parts[1]}`;
        candidate = parts.slice(2).join("\\");
    }
    else if (/^[A-Za-z]:/.test(candidate)) {
        if (candidate.length < 3 || !/[\\/]/.test(candidate[2] ?? "")) {
            return { ok: false, code: "invalid_drive" };
        }
        prefix = `${candidate[0]?.toUpperCase()}:`;
        candidate = candidate.slice(3);
    }
    else {
        return { ok: false, code: "invalid_workspace_root" };
    }
    const output = [];
    for (const rawSegment of splitPath(candidate)) {
        if (rawSegment.length === 0)
            continue;
        if (rawSegment === ".")
            continue;
        if (rawSegment === "..") {
            if (output.length === 0)
                return { ok: false, code: "invalid_workspace_root" };
            output.pop();
            continue;
        }
        const segmentFailure = validateSegment(rawSegment);
        if (segmentFailure !== null)
            return { ok: false, code: segmentFailure };
        if (isReservedBasename(rawSegment))
            return { ok: false, code: "reserved_name" };
        output.push(rawSegment);
    }
    return { ok: true, value: pathToString(prefix, output) };
}
function validateSegment(segment) {
    if (/:/.test(segment))
        return "alternate_data_stream";
    if (/[. ]$/.test(segment))
        return "ambiguous_segment";
    return null;
}
function isReservedBasename(segment) {
    const name = segment.split(".", 1)[0] ?? "";
    return RESERVED_BASENAMES.has(name.toUpperCase());
}
function splitPath(value) {
    return value.split(/[\\/]+/).filter((part) => part.length > 0);
}
function pathToString(prefix, segments) {
    if (prefix.startsWith("\\\\")) {
        return segments.length === 0 ? `${prefix}\\` : `${prefix}\\${segments.join("\\")}`;
    }
    return segments.length === 0 ? `${prefix}\\` : `${prefix}\\${segments.join("\\")}`;
}
function isSameOrChild(root, candidate) {
    const normalizedRoot = root.toLowerCase().replace(/\\$/, "");
    const normalizedCandidate = candidate.toLowerCase().replace(/\\$/, "");
    return (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`));
}
