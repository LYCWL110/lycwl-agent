export function mapFsError(error) {
    if (typeof error !== "object" || error === null)
        return "read_failed";
    const code = error.code;
    if (typeof code !== "string")
        return "read_failed";
    switch (code) {
        case "ENOENT":
            return "not_found";
        case "EACCES":
        case "EPERM":
            return "access_denied";
        case "EBUSY":
            return "locked";
        case "EISDIR":
            return "not_a_regular_file";
        default:
            return "read_failed";
    }
}
