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
