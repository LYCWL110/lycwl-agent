import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDurationMs } from "./src/duration.ts";

/**
 * Independent verifier for evaluation case E04.
 *
 * E04 is different from the other code cases: the task is to *write tests*, not to
 * change behaviour. So this verifier does not assert the product contract directly.
 * It answers two questions:
 *
 * 1. Does the submitted test file pass against the correct implementation?
 * 2. Does it fail against each planted defect?
 *
 * A test file that passes against everything has no discriminating power. A test file
 * that fails against the correct implementation is wrong. Both are failures.
 *
 * The planted defects are applied here, in the verifier's own module scope, by
 * re-implementing the parser with one defect each. A submission that only checks
 * types, swallows exceptions, or asserts nothing will pass the first question and
 * fail every one of the second.
 *
 * How a submission is supplied: the evaluation harness copies the model's test file
 * to `submission.test.ts` beside this verifier and imports it for its side effects.
 * The import is skipped when the file is absent, so this verifier runs standalone
 * during fixture development.
 */

type Parser = (raw: string) => number;

/** The planted defects. Each changes exactly one documented rule. */
const DEFECTS: Readonly<Record<string, Parser>> = {
  "seconds not converted": (raw) => {
    const match = /^(0|[1-9][0-9]*)(ms|s)$/u.exec(raw);
    if (match === null) throw new Error("invalid");
    return Number(match[1]);
  },
  "lenient parseInt accepts trailing characters": (raw) => {
    // Accepts "2seconds" and "2sx" because it only looks at the leading digits.
    const amount = Number.parseInt(raw, 10);
    if (Number.isNaN(amount)) throw new Error("invalid");
    return raw.trimEnd().endsWith("s") ? amount * 1000 : amount;
  },
  "rejects zero": (raw) => {
    const match = /^([1-9][0-9]*)(ms|s)$/u.exec(raw);
    if (match === null) throw new Error("invalid");
    const amount = Number(match[1]);
    return match[2] === "s" ? amount * 1000 : amount;
  },
  "missing overflow check": (raw) => {
    const match = /^(0|[1-9][0-9]*)(ms|s)$/u.exec(raw);
    if (match === null) throw new Error("invalid");
    const amount = Number(match[1]);
    // No safe-integer check: a huge value silently loses precision.
    return match[2] === "s" ? amount * 1000 : amount;
  },
  "accepts leading zeros": (raw) => {
    const match = /^([0-9]+)(ms|s)$/u.exec(raw);
    if (match === null) throw new Error("invalid");
    const amount = Number(match[1]);
    return match[2] === "s" ? amount * 1000 : amount;
  },
};

/**
 * Run a submission's assertions against one implementation.
 *
 * Returns true when the submission accepts the implementation. The submission is a
 * test file, so "accepts" means "every assertion in it passes".
 *
 * This runs the submission through Node's test runner by spawning a child process:
 * a test file registers cases with `describe`/`it`, and there is no supported way to
 * run them in-process from another module. The child is given the implementation via
 * an environment variable that names one of the parsers below.
 */
async function submissionAccepts(
  parserName: "correct" | keyof typeof DEFECTS,
): Promise<Readonly<{ ran: boolean; passed: boolean; output: string }>> {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const submissionPath = path.join(here, "submission.test.ts");
  const { existsSync } = await import("node:fs");
  if (!existsSync(submissionPath)) return { ran: false, passed: false, output: "no submission" };

  const runnerPath = path.join(here, "run-submission.mjs");
  if (!existsSync(runnerPath)) return { ran: false, passed: false, output: "no runner" };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, submissionPath, parserName], {
      cwd: here,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      resolve({ ran: true, passed: code === 0, output });
    });
    child.on("error", () => resolve({ ran: false, passed: false, output: "spawn failed" }));
  });
}

describe("E04: the correct implementation", () => {
  it("satisfies the documented contract", () => {
    // The baseline every submission must accept.
    assert.equal(parseDurationMs("0ms"), 0);
    assert.equal(parseDurationMs("0s"), 0);
    assert.equal(parseDurationMs("250ms"), 250);
    assert.equal(parseDurationMs("2s"), 2000);
    for (const rejected of [
      "",
      " 2s",
      "02s",
      "2seconds",
      "-1s",
      "2.5s",
      "2 s",
      "9007199254740992ms",
    ]) {
      assert.throws(() => parseDurationMs(rejected), Error, rejected);
    }
  });
});

describe("E04: the planted defects change behaviour", () => {
  // These prove the defects are real, so a submission that misses them is a
  // submission with no discriminating power rather than a victim of a bad fixture.
  it("seconds-not-converted differs on seconds", () => {
    assert.notEqual(DEFECTS["seconds not converted"]?.("2s"), parseDurationMs("2s"));
  });

  it("lenient parseInt accepts a trailing character", () => {
    assert.doesNotThrow(() =>
      DEFECTS["lenient parseInt accepts trailing characters"]?.("2seconds"),
    );
  });

  it("rejects-zero differs on zero", () => {
    assert.throws(() => DEFECTS["rejects zero"]?.("0ms"));
  });

  it("missing-overflow-check accepts an unsafe value", () => {
    assert.doesNotThrow(() => DEFECTS["missing overflow check"]?.("9007199254740992ms"));
  });

  it("accepts-leading-zeros differs on a leading zero", () => {
    assert.doesNotThrow(() => DEFECTS["accepts leading zeros"]?.("02s"));
  });
});

describe("E04: a submission's discriminating power", () => {
  it("reports whether a submission exists", async () => {
    const result = await submissionAccepts("correct");
    if (!result.ran) {
      // During fixture development there is no submission. This is a skip, not a
      // pass: the evaluation records it as not_run rather than as success.
      assert.match(result.output, /no submission|no runner/);
      return;
    }
    // A submission that does not accept the correct implementation is wrong.
    assert.equal(result.passed, true, result.output);
  });
});

/** The parsers, exported so the child runner can select one. */
export const PLANTED: Readonly<Record<string, Parser>> = { ...DEFECTS };
