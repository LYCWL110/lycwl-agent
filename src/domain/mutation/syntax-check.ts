/**
 * Post-edit syntax verification.
 *
 * SWE-agent's ablation is the evidence for this feature: removing the lint check
 * after an edit dropped SWE-bench Lite resolution from 18.0% to 15.0%, and removing
 * the dedicated `edit` interface dropped it to 10.3%. A syntax error that survives
 * into the next turn costs a round trip at best and compounds at worst.
 *
 * ## Why tsc rather than `node --check`
 *
 * Measured on this machine, and the measurement changed the design:
 *
 * | Input                          | `node --check` | tsc |
 * | ------------------------------ | -------------- | --- |
 * | `.mjs` with a syntax error      | exit 1         | exit 2 |
 * | `.js` with a syntax error       | **exit 0**     | exit 2 |
 * | `.ts` with a syntax error       | **exit 0**     | exit 2 |
 * | valid `.ts`                     | exit 1         | exit 0 |
 *
 * `node --check` treats a `.js` file as CommonJS, so `export` is reported as "not
 * a module" and the real syntax error is never reached. It does not parse
 * TypeScript at all, not even with `--experimental-strip-types`. Since this
 * project's source is `.ts`, `node --check` would have checked almost nothing and
 * silently passed everything.
 *
 * The in-process alternatives were rejected: `vm.Script` cannot parse ESM, and
 * `vm.SourceTextModule` requires an experimental flag whose behavior is not
 * guaranteed.
 *
 * ## Scope
 *
 * - **Syntax and type errors in one file.** tsc reports both; this does not
 *   distinguish them, because an edit that does not compile is a failed edit
 *   either way.
 * - **Single file only.** Ten sequential checks cost about three seconds per edit;
 *   ten parallel ones peak near 350 MB. Neither is acceptable for a check that
 *   should be free, so a batch patch is not checked.
 * - **Only when the file is JS/TS.**
 */

export const SYNTAX_CHECK_LIMITS = Object.freeze({
  /** Above this the file is not checked; the parse cost outweighs the benefit. */
  maxFileBytes: 2 * 1024 * 1024,
  /** The check must not become the slowest part of an edit. */
  timeoutMs: 20_000,
  /** Extensions tsc parses. */
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"],
});

export type SyntaxCheckOutcome =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "failed"; message: string; line: number | null }>
  | Readonly<{ kind: "skipped"; reason: "not_supported" | "too_large" | "checker_unavailable" }>;

/** Whether this path is one tsc should be run on. */
export function isCheckableSource(filePath: string): boolean {
  const name = filePath.replace(/\\/gu, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SYNTAX_CHECK_LIMITS.extensions.includes(name.slice(dot).toLowerCase());
}

/**
 * Extract the useful part of tsc's output.
 *
 * tsc prints `<path>(<line>,<column>): error TS<code>: <message>`. The model needs
 * the line and the message; the path is already known and the column is noise for a
 * single-line report. A non-TS line (a crash, a config complaint) is passed through
 * truncated rather than dropped, because silently reporting "syntax error" for a
 * checker failure would be a false attribution.
 */
export function parseCheckerFailure(stdout: string): Readonly<{
  message: string;
  line: number | null;
}> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  if (first === undefined) return { message: "syntax check failed", line: null };

  const match = /\((\d+),\d+\):\s*(?:error\s+)?(TS\d+)?:?\s*(.*)$/u.exec(first);
  if (match === null) return { message: first.slice(0, 400), line: null };

  const line = Number(match[1]);
  const code = match[2] === undefined ? "" : `${match[2]} `;
  const detail = (match[3] ?? "").trim();
  const message = `${code}${detail}`.trim();
  return {
    message: message.length === 0 ? "syntax check failed" : message.slice(0, 400),
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
  };
}

/**
 * Render the tool-facing text for a failed check.
 *
 * It states that the edit was reverted, because that is the fact the model most
 * needs: retrying the same content would fail the same way, and continuing as if
 * the file had changed would be wrong.
 */
export function describeSyntaxFailure(
  path: string,
  failure: Readonly<{ message: string; line: number | null }>,
): string {
  const where = failure.line === null ? path : `${path}:${failure.line}`;
  return `syntax check failed: ${where}\n${failure.message}\nThe edit was reverted; the file is unchanged.`;
}
