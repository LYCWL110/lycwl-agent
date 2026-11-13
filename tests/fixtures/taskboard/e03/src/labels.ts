/**
 * Label formatting fixture for evaluation case E03.
 *
 * The task asks for a behaviour-preserving refactor: two callers duplicate the same
 * label handling, and the shared responsibility should be extracted and reused
 * without changing what either caller produces.
 *
 * The current behaviour is narrow and must be preserved exactly:
 * - trim leading and trailing whitespace only;
 * - keep case and Chinese characters as written;
 * - do no Unicode normalization;
 * - throw the existing error when the trimmed label is empty.
 *
 * This file is test input, not Harness code. It is frozen at its initial state.
 */

export class EmptyLabelError extends Error {
  constructor() {
    super("label is empty after trimming");
    this.name = "EmptyLabelError";
  }
}

/** Display in a list row. */
export function formatListLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new EmptyLabelError();
  return `[${trimmed}]`;
}

/** Display in an export column. */
export function formatExportLabel(raw: string): string {
  // The same trimming and the same empty check, written out again.
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new EmptyLabelError();
  return `"${trimmed}"`;
}
