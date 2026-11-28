import { isPosixPath } from "../../domain/path/platform-path.js";
export function isPosixWorkspaceRoot(value) {
    return isPosixPath(value);
}
export function resolvePosixWorkspacePath(root, requested) {
    const normalize = (value) => {
        const segments = [];
        for (const segment of value.split("/")) {
            if (segment === "" || segment === ".")
                continue;
            if (segment === "..")
                segments.pop();
            else
                segments.push(segment);
        }
        return `/${segments.join("/")}`;
    };
    const workspaceRoot = normalize(root);
    const absolutePath = normalize(requested.startsWith("/") ? requested : `${workspaceRoot}/${requested}`);
    return {
        ok: true,
        value: {
            absolutePath,
            workspaceRoot,
            withinWorkspace: workspaceRoot === "/" ||
                absolutePath === workspaceRoot ||
                absolutePath.startsWith(`${workspaceRoot}/`),
            isDirectory: requested.endsWith("/"),
        },
    };
}
export function posixDirectoriesOnPath(root, target, targetIsDirectory) {
    const resolved = resolvePosixWorkspacePath(root, target).value;
    if (!resolved.withinWorkspace)
        return null;
    const base = resolved.workspaceRoot;
    const absolute = resolved.absolutePath;
    const directory = targetIsDirectory
        ? absolute
        : absolute.slice(0, absolute.lastIndexOf("/")) || "/";
    if (directory !== base && !directory.startsWith(base === "/" ? "/" : `${base}/`))
        return null;
    const segments = directory
        .slice(base === "/" ? 1 : base.length + 1)
        .split("/")
        .filter(Boolean);
    return [
        base,
        ...segments.map((_, index) => `${base === "/" ? "" : base}/${segments.slice(0, index + 1).join("/")}`),
    ];
}
