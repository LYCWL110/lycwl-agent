/**
 * Resolve the mode from launch arguments.
 *
 * `--read-only` wins when it appears with either historical flag, so an opt-out
 * cannot be undone by a leftover `--write` in a shell alias.
 */
export function permissionModeFromArgs(args) {
    return args.includes("--read-only") ? "read-only" : "full";
}
