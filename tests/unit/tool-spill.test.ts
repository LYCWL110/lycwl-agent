import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exceedsSpillThreshold,
  SPILL_LIMITS,
  spillToolOutput,
} from "../../src/domain/evidence/tool-spill.ts";

/**
 * Spill preview construction.
 *
 * The rule these tests protect: a spilled result must remain recognizable and
 * actionable. A bare "...truncated" leaves the model unable to tell a complete
 * result from a lost one, and unable to find the rest.
 */

const bigText = (lines: number, prefix = "line"): string =>
  Array.from({ length: lines }, (_unused, index) => `${prefix} ${index}`).join("\n");

describe("spillToolOutput", () => {
  it("keeps a small result inline", () => {
    const text = "short output";
    assert.deepEqual(spillToolOutput({ text, reference: "spill/x.txt", toolName: "probe" }), {
      kind: "inline",
      text,
    });
  });

  it("keeps a result exactly at the threshold inline", () => {
    const text = "x".repeat(SPILL_LIMITS.thresholdUnits);
    const result = spillToolOutput({ text, reference: "spill/x.txt", toolName: "probe" });
    assert.equal(result.kind, "inline");
  });

  it("spills a result just over the threshold", () => {
    const text = "x".repeat(SPILL_LIMITS.thresholdUnits + 1);
    const result = spillToolOutput({ text, reference: "spill/x.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
  });

  it("reports the total size, the reference and how to read the rest", () => {
    const text = bigText(5_000);
    const result = spillToolOutput({ text, reference: "spill/abc.txt", toolName: "shell" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    assert.match(result.preview, /output spilled: \d+ chars total/);
    assert.match(result.preview, /tool: shell/);
    assert.match(result.preview, /full output: spill\/abc\.txt/);
    assert.match(result.preview, /read the rest with read_file/);
  });

  it("keeps the start, the end of the window, and says how much is missing", () => {
    const text = bigText(5_000);
    const result = spillToolOutput({ text, reference: "spill/abc.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    // The head starts at the beginning and the tail reaches the last line, because
    // 4,000 units is more than enough for the final lines. The exact boundary is not
    // asserted: it depends on the line length, and pinning it would make the test
    // fail for a harmless reason.
    assert.match(result.preview, /line 0\n/);
    assert.match(result.preview, /line 4999$/m);
    assert.match(result.preview, /chars omitted/);
  });

  it("drops middle content when the middle is larger than both windows", () => {
    // 5,000 lines is about 49k characters: the 8k head and 4k tail cannot cover it,
    // so the gap is real and must be reported rather than silently closed.
    const text = bigText(5_000);
    const result = spillToolOutput({ text, reference: "spill/abc.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    const omitted = /--- \.\.\. (\d+) chars omitted \.\.\. ---/u.exec(result.preview);
    assert.notEqual(omitted, null);
    assert.ok(Number(omitted?.[1]) > 30_000, "the gap should be most of the text");
  });

  it("produces a preview smaller than the original", () => {
    const text = bigText(5_000);
    const result = spillToolOutput({ text, reference: "spill/abc.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    assert.equal(result.reduced, true);
    assert.ok(result.preview.length < text.length);
  });

  it("does not present a partial first tail line as content", () => {
    // The tail window starts mid-line, so the fragment before the first newline
    // must be dropped rather than shown as a mangled record.
    const text = `${"a".repeat(100)}\n${bigText(5_000, "tail")}`;
    const result = spillToolOutput({ text, reference: "spill/x.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    const tailSection = result.preview.slice(result.preview.indexOf("--- tail ---"));
    assert.match(tailSection, /tail \d+/);
  });

  it("handles text with no newlines at all", () => {
    const text = "y".repeat(SPILL_LIMITS.thresholdUnits + 500);
    const result = spillToolOutput({ text, reference: "spill/x.txt", toolName: "probe" });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    assert.match(result.preview, /chars omitted/);
  });

  it("shows an unreadable reference as needing approval", () => {
    // The caller passes a marked reference when the file is outside the workspace.
    const text = bigText(5_000);
    const result = spillToolOutput({
      text,
      reference: "C:\\temp\\x.txt (outside the workspace; reading it needs approval)",
      toolName: "probe",
    });
    assert.equal(result.kind, "spilled");
    if (result.kind !== "spilled") return;
    assert.match(result.preview, /needs approval/);
  });
});

describe("exceedsSpillThreshold", () => {
  it("is false at the threshold and true above it", () => {
    assert.equal(exceedsSpillThreshold(SPILL_LIMITS.thresholdUnits), false);
    assert.equal(exceedsSpillThreshold(SPILL_LIMITS.thresholdUnits + 1), true);
  });
});
