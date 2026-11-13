#!/usr/bin/env node

/**
 * Run a submitted test file against one implementation of `parseDurationMs`.
 *
 * Evaluation case E04 asks the model to write tests, so the grader has to run those
 * tests against a correct parser and against planted defects. A test file registers
 * cases with Node's test runner, which cannot be invoked in-process from another
 * module, so this is a child process.
 *
 * The implementation is injected by rewriting the module the submission imports:
 * `src/duration.ts` is copied to a temporary path, the parser is replaced with the
 * requested variant, and the submission's import is redirected to the copy. The
 * fixture file itself is never modified.
 *
 * Usage: node run-submission.mjs <submission-path> <parser-name>
 * Exit 0 means every assertion in the submission passed.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [submissionPath, parserName] = process.argv.slice(2);

if (submissionPath === undefined || parserName === undefined) {
  process.stderr.write("usage: run-submission.mjs <submission-path> <parser-name>\n");
  process.exit(2);
}

/** The correct parser, copied from the fixture so the two cannot drift. */
const CORRECT = readFileSync(path.join(here, "src", "duration.ts"), "utf8");

/** Replacements applied to the correct source. Each changes one documented rule. */
const VARIANTS = {
  correct: (source) => source,
  "seconds not converted": (source) =>
    source.replace(
      'const milliseconds = unit === "s" ? amount * 1000 : amount;',
      "const milliseconds = amount;",
    ),
  "lenient parseInt accepts trailing characters": (source) =>
    source
      .replace(
        "const match = PATTERN.exec(raw);",
        'const match = /^([0-9]+)/u.exec(raw) === null ? null : [raw, String(Number.parseInt(raw, 10)), raw.trimEnd().endsWith("s") ? "s" : "ms"];',
      )
      .replace(
        "if (match === null) throw new DurationError",
        "if (match === null) throw new DurationError",
      ),
  "rejects zero": (source) =>
    source.replace(
      "const PATTERN = /^(0|[1-9][0-9]*)(ms|s)$/u;",
      "const PATTERN = /^([1-9][0-9]*)(ms|s)$/u;",
    ),
  "missing overflow check": (source) =>
    source.replace("if (!Number.isSafeInteger(milliseconds)) {", "if (false) {"),
  "accepts leading zeros": (source) =>
    source.replace(
      "const PATTERN = /^(0|[1-9][0-9]*)(ms|s)$/u;",
      "const PATTERN = /^([0-9]+)(ms|s)$/u;",
    ),
};

const variant = VARIANTS[parserName];
if (variant === undefined) {
  process.stderr.write(`unknown parser: ${parserName}\n`);
  process.exit(2);
}

const patched = variant(CORRECT);
if (patched === CORRECT && parserName !== "correct") {
  // A replacement that did not apply means the fixture source changed shape. Fail
  // loudly rather than running the correct implementation under a defect's name.
  process.stderr.write(`variant ${parserName} did not apply; fixture source changed\n`);
  process.exit(3);
}

const work = mkdtempSync(path.join(tmpdir(), "e04-"));
try {
  const target = path.join(work, "duration.ts");
  writeFileSync(target, patched, "utf8");

  // Redirect the submission's import to the patched copy.
  const original = readFileSync(submissionPath, "utf8");
  const redirected = original.replace(
    /from\s+["'][^"']*duration(?:\.ts)?["']/gu,
    `from ${JSON.stringify(pathToFileURL(target).href)}`,
  );
  if (redirected === original) {
    process.stderr.write("submission does not import duration; cannot inject a defect\n");
    process.exit(3);
  }
  const redirectedPath = path.join(work, "submission.test.ts");
  writeFileSync(redirectedPath, redirected, "utf8");

  const result = spawnSync(process.execPath, ["--test", redirectedPath], {
    cwd: work,
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
