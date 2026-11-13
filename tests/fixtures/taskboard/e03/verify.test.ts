import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EmptyLabelError, formatExportLabel, formatListLabel } from "./src/labels.ts";

/**
 * Independent verifier for evaluation case E03.
 *
 * The task is a behaviour-preserving refactor: extract the duplicated label
 * handling so both callers reuse it, with no change in what either produces.
 *
 * There is deliberately no FAIL_TO_PASS assertion. The initial state is correct, and
 * manufacturing a failure would reward breaking it. What this verifier checks is
 * behavioural equivalence across the cases where a careless refactor goes wrong:
 * Unicode normalization, case folding, and inner whitespace.
 *
 * The structural requirement — that the duplication is actually gone — cannot be
 * decided mechanically without pinning one exact code shape, which the specification
 * forbids. It is checked by reading the diff against the rubric in the case manifest.
 */

describe("E03 PASS_TO_PASS: behaviour that must not change", () => {
  it("trims leading and trailing whitespace", () => {
    assert.equal(formatListLabel("  alpha  "), "[alpha]");
    assert.equal(formatExportLabel("  alpha  "), '"alpha"');
  });

  it("keeps inner whitespace", () => {
    assert.equal(formatListLabel("a  b"), "[a  b]");
    assert.equal(formatExportLabel("a  b"), '"a  b"');
  });

  it("keeps case", () => {
    assert.equal(formatListLabel("Alpha"), "[Alpha]");
    assert.equal(formatListLabel("ALPHA"), "[ALPHA]");
  });

  it("keeps Chinese characters without normalization", () => {
    assert.equal(formatListLabel("任务"), "[任务]");
    assert.equal(formatExportLabel("  任务  "), '"任务"');
  });

  it("does not apply Unicode normalization", () => {
    // NFC and NFD forms must stay distinct: normalizing would change the bytes a
    // caller sees, which is a behaviour change even though it looks identical.
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    assert.notEqual(nfc, nfd);
    assert.equal(formatListLabel(nfc), `[${nfc}]`);
    assert.equal(formatListLabel(nfd), `[${nfd}]`);
    assert.notEqual(formatListLabel(nfc), formatListLabel(nfd));
  });

  it("rejects an empty label", () => {
    assert.throws(() => formatListLabel(""), EmptyLabelError);
  });

  it("rejects a whitespace-only label", () => {
    assert.throws(() => formatListLabel("   "), EmptyLabelError);
    assert.throws(() => formatExportLabel("\t\n"), EmptyLabelError);
  });

  it("both callers agree on the trimmed value", () => {
    // The shared responsibility is trimming; the wrappers differ only in decoration.
    for (const input of ["  alpha  ", "任务", "a  b", "Alpha"]) {
      assert.equal(formatListLabel(input).slice(1, -1), formatExportLabel(input).slice(1, -1));
    }
  });

  it("both callers agree on the error", () => {
    for (const input of ["", "   ", "\t"]) {
      assert.throws(() => formatListLabel(input), EmptyLabelError, input);
      assert.throws(() => formatExportLabel(input), EmptyLabelError, input);
    }
  });
});

describe("E03 negative controls", () => {
  /**
   * A refactor that normalizes Unicode looks correct on ASCII input and changes
   * behaviour on the one case that matters.
   */
  const normalizing = (raw: string): string => {
    const trimmed = raw.normalize("NFC").trim();
    if (trimmed.length === 0) throw new EmptyLabelError();
    return `[${trimmed}]`;
  };

  /** A refactor that folds case changes behaviour on any mixed-case label. */
  const folding = (raw: string): string => {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) throw new EmptyLabelError();
    return `[${trimmed}]`;
  };

  /** A refactor that collapses inner whitespace changes behaviour on "a  b". */
  const collapsing = (raw: string): string => {
    const trimmed = raw.trim().replace(/\s+/gu, " ");
    if (trimmed.length === 0) throw new EmptyLabelError();
    return `[${trimmed}]`;
  };

  const matchesCurrentBehaviour = (implementation: (raw: string) => string): boolean => {
    try {
      const cases = ["  alpha  ", "a  b", "Alpha", "任务", "cafe\u0301"];
      for (const input of cases) {
        assert.equal(implementation(input), formatListLabel(input), input);
      }
      assert.throws(() => implementation(""), EmptyLabelError);
      assert.throws(() => implementation("   "), EmptyLabelError);
      return true;
    } catch {
      return false;
    }
  };

  it("the current implementation passes", () => {
    assert.equal(matchesCurrentBehaviour(formatListLabel), true);
  });

  it("rejects: normalizing Unicode", () => {
    assert.equal(matchesCurrentBehaviour(normalizing), false);
  });

  it("rejects: folding case", () => {
    assert.equal(matchesCurrentBehaviour(folding), false);
  });

  it("rejects: collapsing inner whitespace", () => {
    assert.equal(matchesCurrentBehaviour(collapsing), false);
  });
});
