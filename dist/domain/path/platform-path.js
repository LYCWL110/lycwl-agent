export function isPosixPath(value) {
    return value.startsWith("/") && !value.startsWith("//");
}
