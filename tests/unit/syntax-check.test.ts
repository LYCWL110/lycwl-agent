import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeSyntaxFailure,
  isCheckableSource,
  parseCheckerFailure,
  SYNTAX_CHECK_LIMITS,
} from "../../src/domain/mutation/syntax-check.ts";

/**
 * Post-edit syntax verification.
 *
 * The rule these tests protect: a checker that cannot run must never be reported as
 * a pass. Claiming a file compiles when nothing checked it is a false verification,
 * and the whole point of the check is to avoid exactly that.
 */

describe("isCheckableSource", () => {
  it("accepts TypeScript and JavaScript", () => {
    for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.mjs", "a.cjs", "a.jsx"]) {
      assert.equal(isCheckableSource(path), true, path);
    }
  });

  it("rejects non-source files", () => {
    // Running the checker on these would produce a false failure.
    for (const path of ["a.md", "a.json", "a.yaml", "a.css", "Makefile", "a"]) {
      assert.equal(isCheckableSource(path), false, path);
    }
  });

  it("is case-insensitive about the extension", () => {
    assert.equal(isCheckableSource("A.TS"), true);
  });

  it("looks at the basename, not the directory", () => {
    // A directory named `a.ts` must not make its children checkable.
    assert.equal(isCheckableSource("a.ts/b.md"), false);
  });

  it("handles Windows separators", () => {
    assert.equal(isCheckableSource("src\\a.ts"), true);
  });
});

describe("parseCheckerFailure", () => {
  it("extracts the line, code and message", () => {
    const parsed = parseCheckerFailure(
      "C:/p/a.ts(1,27): error TS1136: Property assignment expected.",
    );
    assert.deepEqual(parsed, {
      message: "TS1136 Property assignment expected.",
      line: 1,
    });
  });

  it("extracts a type error the same way", () => {
    const parsed = parseCheckerFailure(
      "C:/p/a.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    assert.equal(parsed.line, 3);
    assert.match(parsed.message, /TS2322/);
  });

  it("reports the first error only", () => {
    // A single line and message is what the model can act on; a list of ten
    // cascading errors from one mistake is noise.
    const parsed = parseCheckerFailure(
      "C:/p/a.ts(1,27): error TS1136: Property assignment expected.\nC:/p/a.ts(1,28): error TS1180: Property destructuring pattern expected.",
    );
    assert.equal(parsed.line, 1);
    assert.match(parsed.message, /TS1136/);
  });

  it("passes through an unrecognized line rather than inventing a syntax error", () => {
    // A crash or config complaint is not a syntax error; calling it one would be a
    // false attribution.
    const parsed = parseCheckerFailure(
      "error TS6044: Compiler option 'types' expects an argument.",
    );
    assert.equal(parsed.line, null);
    assert.match(parsed.message, /TS6044/);
  });

  it("handles empty output", () => {
    const parsed = parseCheckerFailure("");
    assert.equal(parsed.line, null);
    assert.equal(parsed.message, "syntax check failed");
  });

  it("truncates a very long message", () => {
    const long = `C:/p/a.ts(1,1): error TS1: ${"x".repeat(1_000)}`;
    const parsed = parseCheckerFailure(long);
    assert.ok(parsed.message.length <= 400);
  });
});

describe("describeSyntaxFailure", () => {
  it("states the location, the reason and that the edit was reverted", () => {
    const text = describeSyntaxFailure("a.ts", {
      message: "TS1136 Property assignment expected.",
      line: 1,
    });
    assert.match(text, /a\.ts:1/);
    assert.match(text, /TS1136/);
    // The revert is the fact the model most needs: retrying the same content fails
    // the same way, and continuing as if the file changed would be wrong.
    assert.match(text, /reverted/);
    assert.match(text, /unchanged/);
  });

  it("omits the line when it is unknown", () => {
    const text = describeSyntaxFailure("a.ts", { message: "boom", line: null });
    assert.match(text, /^syntax check failed: a\.ts$/m);
  });
});

describe("limits", () => {
  it("keeps the timeout bounded", () => {
    assert.ok(SYNTAX_CHECK_LIMITS.timeoutMs <= 20_000);
  });

  it("skips a file above the size cap", () => {
    assert.equal(SYNTAX_CHECK_LIMITS.maxFileBytes, 2 * 1024 * 1024);
  });
});
