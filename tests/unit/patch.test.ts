import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyHunks,
  joinLines,
  PATCH_LIMITS,
  parseUnifiedDiff,
  splitLines,
} from "../../src/domain/mutation/patch.ts";

describe("unified diff parsing", () => {
  it("parses one target with a single hunk", () => {
    const result = parseUnifiedDiff(
      ["--- a/src.ts", "+++ b/src.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join(
        "\n",
      ),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.targets.length, 1);
    const target = result.targets[0];
    assert.equal(target?.path, "src.ts");
    assert.deepEqual(target?.hunks[0], {
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 3,
      lines: [" one", "-two", "+TWO", " three"],
    });
  });

  it("parses multiple targets and multiple hunks", () => {
    const diff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "@@ -10,1 +10,2 @@",
      " keep",
      "+added",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -2,1 +2,1 @@",
      "-x",
      "+y",
    ].join("\n");

    const result = parseUnifiedDiff(diff);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.targets.map((target) => target.path),
      ["a.ts", "b.ts"],
    );
    assert.equal(result.targets[0]?.hunks.length, 2);
  });

  it("defaults a missing count to one", () => {
    const result = parseUnifiedDiff(["--- a/f", "+++ b/f", "@@ -3 +3 @@", "-a", "+b"].join("\n"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.targets[0]?.hunks[0], {
      oldStart: 3,
      oldCount: 1,
      newStart: 3,
      newCount: 1,
      lines: ["-a", "+b"],
    });
  });

  it("rejects a duplicate target in one batch", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+c",
    ].join("\n");
    assert.deepEqual(parseUnifiedDiff(diff), { ok: false, code: "duplicate_target" });
  });

  it("rejects a malformed hunk header or body", () => {
    assert.deepEqual(parseUnifiedDiff(["--- a/f", "+++ b/f", "@@ bad @@"].join("\n")), {
      ok: false,
      code: "invalid_hunk_header",
    });
    assert.deepEqual(
      parseUnifiedDiff(["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-a", "+b"].join("\n")),
      { ok: false, code: "invalid_hunk_body" },
    );
  });

  it("rejects a target with no hunks and a missing file header", () => {
    assert.deepEqual(parseUnifiedDiff(["--- a/f", "+++ b/f"].join("\n")), {
      ok: false,
      code: "no_hunks",
    });
    assert.deepEqual(parseUnifiedDiff(["--- a/f", "@@ -1 +1 @@", "-a", "+b"].join("\n")), {
      ok: false,
      code: "missing_file_header",
    });
  });

  it("rejects more than 64 targets", () => {
    const chunks: string[] = [];
    for (let index = 0; index <= PATCH_LIMITS.maxTargets; index += 1) {
      chunks.push(`--- a/f${index}`, `+++ b/f${index}`, "@@ -1,1 +1,1 @@", "-a", "+b");
    }
    assert.deepEqual(parseUnifiedDiff(chunks.join("\n")), {
      ok: false,
      code: "too_many_targets",
    });
  });
});

describe("hunk application", () => {
  it("applies context, removal and addition lines", () => {
    const original = splitLines("one\ntwo\nthree\n");
    const parsed = parseUnifiedDiff(
      ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const applied = applyHunks(original, parsed.targets[0]?.hunks ?? []);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.deepEqual(applied.lines, ["one", "TWO", "three"]);
  });

  it("applies two distant hunks without touching the middle", () => {
    const original = splitLines("a\nb\nc\nd\ne\nf\n");
    const parsed = parseUnifiedDiff(
      ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-a", "+A", "@@ -6,1 +6,1 @@", "-f", "+F"].join(
        "\n",
      ),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const applied = applyHunks(original, parsed.targets[0]?.hunks ?? []);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.deepEqual(applied.lines, ["A", "b", "c", "d", "e", "F"]);
  });

  it("rejects a context mismatch without applying anything", () => {
    const original = splitLines("one\nWRONG\nthree\n");
    const parsed = parseUnifiedDiff(
      ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(applyHunks(original, parsed.targets[0]?.hunks ?? []), {
      ok: false,
      code: "context_mismatch",
    });
  });

  it("rejects overlapping hunks", () => {
    const original = splitLines("a\nb\nc\n");
    assert.deepEqual(
      applyHunks(original, [
        { oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" a", "-b", "+B"] },
        { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, lines: ["-b", "+X"] },
      ]),
      { ok: false, code: "overlapping_hunks" },
    );
  });

  it("rejects a hunk beyond the end of the file", () => {
    assert.deepEqual(
      applyHunks(splitLines("a\n"), [
        { oldStart: 9, oldCount: 1, newStart: 9, newCount: 1, lines: ["-a", "+b"] },
      ]),
      { ok: false, code: "hunk_out_of_range" },
    );
  });
});

describe("line helpers", () => {
  it("splits without inventing a trailing empty line", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
    assert.deepEqual(splitLines(""), []);
  });

  it("joins with the requested terminator", () => {
    assert.equal(joinLines(["a", "b"], "\n"), "a\nb\n");
    assert.equal(joinLines(["a", "b"], "\r\n"), "a\r\nb\r\n");
    assert.equal(joinLines([], "\n"), "");
  });
});
