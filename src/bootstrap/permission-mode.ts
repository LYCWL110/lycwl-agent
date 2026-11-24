/**
 * Launch permission mode.
 *
 * The default is full: writes and shell are available, and every action still
 * requires its own approval. `--read-only` is the explicit opt-out.
 *
 * `--write` and `--shell` are historical flags from the three-mode model. They
 * are accepted for compatibility and ignored: there is no write-only mode any
 * more, and a script that passed `--shell` must not accidentally select a
 * narrower mode than it asked for.
 */
export type PermissionMode = "read-only" | "full";

/**
 * Resolve the mode from launch arguments.
 *
 * `--read-only` wins when it appears with either historical flag, so an opt-out
 * cannot be undone by a leftover `--write` in a shell alias.
 */
export function permissionModeFromArgs(args: readonly string[]): PermissionMode {
  return args.includes("--read-only") ? "read-only" : "full";
}
