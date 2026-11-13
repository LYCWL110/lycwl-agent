/**
 * Case manifests for evaluation cases E01-E06.
 *
 * A manifest records what the specification requires: case identity, the requirement,
 * the initial state and its content hash, what may and may not change, which material
 * is visible to the model versus held by the grader, and which sampling branch is the
 * first one.
 *
 * The initial-state hash is computed from the fixture files, not written by hand, so
 * it cannot drift from what is on disk. A fixture that changes invalidates its hash
 * and the evaluation must re-register it rather than silently compare against a
 * different starting point.
 *
 * This is the record, not an executable schema. The specification says the formal
 * engineering still needs to produce these entities; this file is that production for
 * the cases that exist.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export type CaseManifest = Readonly<{
  caseId: "E01" | "E02" | "E03" | "E04" | "E05" | "E06";
  /** Bumped when the fixture or the verifier changes. */
  version: number;
  requirement: string;
  /** Files the model may read, relative to the case directory. */
  visibleFiles: readonly string[];
  /** Files the model may change. Anything else is out of scope. */
  mutableFiles: readonly string[];
  /** Files that must not change, verified by the runner. */
  immutableFiles: readonly string[];
  /** The grader's files, never shown to the model. */
  verifierFiles: readonly string[];
  /** sha256 of the initial state of each mutable file. */
  initialHashes: Readonly<Record<string, string>>;
  /** The branch the first quality sampling uses. */
  firstBranch: string;
  /** Assertions that must fail before a fix and pass after. Empty for E03. */
  failToPass: readonly string[];
  /** Assertions that must pass before and after. */
  passToPass: readonly string[];
}>;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hashOf(caseDir: string, relative: string): string {
  return sha256(path.join(here, caseDir, relative));
}

/**
 * The manifests.
 *
 * `immutableFiles` lists what the runner compares after a sample: a fix that edits a
 * test, or the unrelated UI package, fails the process check even when the code is
 * correct.
 */
export const CASE_MANIFESTS: readonly CaseManifest[] = Object.freeze([
  {
    caseId: "E01",
    version: 1,
    requirement:
      "splitIntoChunks drops a final chunk that is exactly the requested size. Fix the boundary while keeping input order, not modifying the input, and rejecting a non-positive or non-integer size.",
    visibleFiles: ["src/chunks.ts", "src/chunks.public.test.ts"],
    mutableFiles: ["src/chunks.ts"],
    immutableFiles: ["src/chunks.public.test.ts", "verify.test.ts"],
    verifierFiles: ["verify.test.ts"],
    initialHashes: { "src/chunks.ts": hashOf("e01", "src/chunks.ts") },
    firstBranch: "standard defect fix",
    failToPass: [
      "keeps a final chunk that is exactly the requested size",
      "keeps every element when the length is a multiple of size",
    ],
    passToPass: [
      "splits a non-divisible list",
      "returns an empty list for empty input",
      "puts each item in its own chunk when size is 1",
      "keeps every element when size exceeds the length",
      "preserves input order",
      "does not modify the input array",
    ],
  },
  {
    caseId: "E02",
    version: 1,
    requirement:
      "Add optional status and limit to TaskRepository.list, threaded through the interface, the memory implementation and the caller. Omitted status returns all; limit is a non-negative integer, 0 returns empty, filter before limiting, keep insertion order.",
    visibleFiles: ["src/tasks.ts"],
    mutableFiles: ["src/tasks.ts"],
    immutableFiles: ["verify.test.ts"],
    verifierFiles: ["verify.test.ts"],
    initialHashes: { "src/tasks.ts": hashOf("e02", "src/tasks.ts") },
    firstBranch: "one small feature threaded through",
    failToPass: ["filters by status", "limits the result", "filters before limiting"],
    passToPass: [
      "returns everything when called with no arguments",
      "keeps insertion order",
      "does not modify the store across repeated calls",
      "the existing caller still works",
    ],
  },
  {
    caseId: "E03",
    version: 1,
    requirement:
      "The list and export formatters duplicate the same label handling. Extract the shared responsibility and reuse it. External behaviour must not change: trim only, keep case and Chinese characters, no Unicode normalization, throw the existing error when the trimmed label is empty.",
    visibleFiles: ["src/labels.ts"],
    mutableFiles: ["src/labels.ts"],
    immutableFiles: ["verify.test.ts"],
    verifierFiles: ["verify.test.ts"],
    initialHashes: { "src/labels.ts": hashOf("e03", "src/labels.ts") },
    firstBranch: "behaviour-preserving refactor",
    // E03 has no defect. Manufacturing a FAIL_TO_PASS would reward breaking it.
    failToPass: [],
    passToPass: [
      "trims leading and trailing whitespace",
      "keeps inner whitespace",
      "keeps case",
      "keeps Chinese characters without normalization",
      "does not apply Unicode normalization",
      "rejects an empty label",
      "rejects a whitespace-only label",
      "both callers agree on the trimmed value",
      "both callers agree on the error",
    ],
  },
  {
    caseId: "E04",
    version: 1,
    requirement:
      "The implementation of parseDurationMs is correct but barely tested. Add boundary and error tests that discriminate: they must pass against the correct implementation and fail against each planted defect. Do not change product behaviour to make tests pass.",
    visibleFiles: ["src/duration.ts", "src/duration.public.test.ts"],
    mutableFiles: ["src/duration.public.test.ts"],
    immutableFiles: ["src/duration.ts", "verify.test.ts", "run-submission.mjs"],
    verifierFiles: ["verify.test.ts", "run-submission.mjs"],
    initialHashes: { "src/duration.public.test.ts": hashOf("e04", "src/duration.public.test.ts") },
    firstBranch: "test completion",
    // The submission is the test file; its discrimination is measured, not its
    // assertions against a fixed implementation.
    failToPass: [],
    passToPass: [
      "the submitted tests pass against the correct implementation",
      "the submitted tests fail against each planted defect",
    ],
  },
  {
    caseId: "E05",
    version: 1,
    requirement:
      "In apps/board, fix the filter so a non-archived task with an empty or whitespace-only title is visible. Obey the root and package AGENTS.md rules and do not modify packages/ui.",
    visibleFiles: [
      "AGENTS.md",
      "apps/board/AGENTS.md",
      "apps/board/src/filter.ts",
      "packages/ui/src/card.ts",
    ],
    mutableFiles: ["apps/board/src/filter.ts"],
    immutableFiles: [
      "AGENTS.md",
      "apps/board/AGENTS.md",
      "packages/ui/src/card.ts",
      "apps/board/verify.test.ts",
    ],
    verifierFiles: ["apps/board/verify.test.ts"],
    initialHashes: { "apps/board/src/filter.ts": hashOf("e05", "apps/board/src/filter.ts") },
    firstBranch: "confirmed AGENTS hierarchy",
    failToPass: ["keeps a non-archived task with an empty title"],
    passToPass: [
      "drops an archived task",
      "keeps the input order",
      "returns an empty list for empty input",
      "does not modify the input",
    ],
  },
  {
    caseId: "E06",
    version: 1,
    requirement:
      "Fix the sort in src/中文 路径/labels.ts so labels order by text then id, using code-point comparison. Preserve the file's UTF-8 BOM and CRLF line endings and every byte outside the fix.",
    visibleFiles: ["src/中文 路径/labels.ts"],
    mutableFiles: ["src/中文 路径/labels.ts"],
    immutableFiles: ["verify.test.ts"],
    verifierFiles: ["verify.test.ts"],
    initialHashes: { "src/中文 路径/labels.ts": hashOf("e06", "src/中文 路径/labels.ts") },
    firstBranch: "fixed BOM and CRLF format",
    failToPass: ["orders by text", "breaks a tie by id"],
    passToPass: [
      "does not modify the input",
      "returns an empty list for empty input",
      "keeps a single element",
      "orders Chinese text by code point, not by locale collation",
      "keeps the UTF-8 BOM",
      "keeps CRLF line endings",
    ],
  },
]);

export function manifestFor(caseId: CaseManifest["caseId"]): CaseManifest {
  const found = CASE_MANIFESTS.find((manifest) => manifest.caseId === caseId);
  if (found === undefined) throw new Error(`unknown case: ${caseId}`);
  return found;
}

/** Recompute a mutable file's hash, to detect that a fixture changed under a sample. */
export function currentHash(caseId: CaseManifest["caseId"], relative: string): string {
  const directory = caseId.toLowerCase();
  return hashOf(directory, relative);
}
