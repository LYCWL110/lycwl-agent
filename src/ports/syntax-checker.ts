import type { SyntaxCheckOutcome } from "../domain/mutation/syntax-check.ts";

/**
 * Post-edit syntax verification.
 *
 * The coordinator needs to know whether an edit still compiles, but it must not
 * know which compiler runs or how. Keeping the type here lets the application layer
 * depend on the capability rather than on a child process.
 */
export type SyntaxChecker = Readonly<{
  check: (absolutePath: string) => Promise<SyntaxCheckOutcome>;
}>;

/**
 * Reverts the files a Run changed.
 *
 * The coordinator needs to undo an edit that failed verification, but the file
 * system belongs to an adapter. The application layer depends on this shape.
 */
export type ChangeReverter = (input: {
  runId: string;
  workspaceRoot: string;
}) => Promise<Readonly<{ ok: true; files: number }> | Readonly<{ ok: false; code: string }>>;
