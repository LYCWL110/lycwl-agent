import type { FormatterDefinition } from "../domain/format/formatter.ts";

/**
 * Project formatter.
 *
 * The coordinator needs to run the project's formatter after a file change, but it
 * must not know how the formatter is discovered or executed. Keeping the type here
 * lets the application layer depend on the capability rather than on a child
 * process.
 */
export type FormatResult =
  | Readonly<{ ok: true; formatter: string }>
  | Readonly<{
      ok: false;
      code:
        | "no_configuration"
        | "unsupported_extension"
        | "not_installed"
        | "invalid_path"
        | "excluded_path"
        | "format_failed"
        | "timeout";
      detail?: string;
    }>;

export type FormatterRunner = Readonly<{
  /**
   * Format one workspace-relative file.
   *
   * `resolvedPath` must already be inside the workspace; the caller owns that
   * check, because it owns the workspace boundary.
   */
  format: (input: { relativePath: string; resolvedPath: string }) => Promise<FormatResult>;
  /** Which formatter this workspace uses, or null when none is configured. */
  detect: () => Promise<FormatterDefinition | null>;
}>;
