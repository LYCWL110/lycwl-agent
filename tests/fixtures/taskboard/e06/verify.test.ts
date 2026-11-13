import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { type Label, sortLabels } from "./src/中文 路径/labels.ts";

/**
 * Independent verifier for evaluation case E06.
 *
 * The task: fix a logic defect in `src/中文 路径/labels.ts` while preserving the
 * file's encoding and line endings, and report bounded output honestly.
 *
 * Three separate results:
 *
 * 1. **Function**: labels sort by text, then by id.
 * 2. **Format**: the file keeps its UTF-8 BOM and its CRLF line endings. A fix that
 *    rewrites the whole file with LF, or drops the BOM, changes bytes the user did
 *    not ask to change, so it fails even though the logic is right.
 * 3. **Report**: handled by the evaluation runner, which compares the tool result's
 *    attachment and truncation facts against the actual capture. It cannot be
 *    asserted here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(here, "src", "中文 路径", "labels.ts");

/**
 * Ids and texts are deliberately not in the same order.
 *
 * Sorting by id and sorting by text must produce different results, or the defect is
 * invisible: an earlier version of this sample had them agree, and the failing case
 * passed under the wrong implementation.
 */
const SAMPLE: readonly Label[] = [
  { id: "a", text: "zulu" },
  { id: "b", text: "alpha" },
  { id: "c", text: "mike" },
  { id: "d", text: "任务" },
];

/**
 * Expected order under code-point comparison: alpha(b) < mike(c) < zulu(a) < 任务(d).
 *
 * Latin letters have lower code points than CJK, so 任务 sorts last. A locale-aware
 * comparison puts it first, which is why this sample distinguishes the two.
 */
const SAMPLE_BY_TEXT = ["b", "c", "a", "d"] as const;

describe("E06 FAIL_TO_PASS: sort by text, then by id", () => {
  it("orders by text", () => {
    assert.deepEqual(
      sortLabels(SAMPLE).map((label) => label.id),
      [...SAMPLE_BY_TEXT],
    );
  });

  it("breaks a tie by id", () => {
    // alpha appears twice; id decides, and the input has them out of order.
    const tied: readonly Label[] = [
      { id: "z", text: "same" },
      { id: "a", text: "same" },
    ];
    assert.deepEqual(
      sortLabels(tied).map((label) => label.id),
      ["a", "z"],
    );
  });
});

describe("E06 PASS_TO_PASS: behaviour that must not change", () => {
  it("does not modify the input", () => {
    const input = [...SAMPLE];
    sortLabels(input);
    assert.deepEqual(input, SAMPLE);
  });

  it("returns an empty list for empty input", () => {
    assert.deepEqual(sortLabels([]), []);
  });

  it("keeps a single element", () => {
    assert.deepEqual(sortLabels([SAMPLE[0] as Label]), [SAMPLE[0]]);
  });

  it("orders Chinese text by code point, not by locale collation", () => {
    // A locale-aware comparison puts 任务 before alpha; code-point comparison puts it
    // after, because 0x4EFB is greater than 0x61. The contract is code-point order so
    // the result does not depend on the machine's locale.
    const labels: readonly Label[] = [
      { id: "1", text: "任务" },
      { id: "2", text: "alpha" },
    ];
    assert.deepEqual(
      sortLabels(labels).map((label) => label.text),
      ["alpha", "任务"],
    );
    assert.equal("任务".localeCompare("alpha") < 0, true, "localeCompare disagrees here");
  });
});

describe("E06 format preservation", () => {
  it("keeps the UTF-8 BOM", () => {
    const bytes = readFileSync(TARGET);
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      "the file must keep its byte-order mark",
    );
  });

  it("keeps CRLF line endings", () => {
    const bytes = readFileSync(TARGET);
    const text = bytes.toString("utf8");
    const crlf = (text.match(/\r\n/gu) ?? []).length;
    // A bare LF is any LF not preceded by CR.
    const bareLf = (text.match(/(?<!\r)\n/gu) ?? []).length;
    assert.ok(crlf > 0, "expected CRLF line endings");
    assert.equal(bareLf, 0, "no bare LF may be introduced");
  });

  it("keeps the file's non-target content", () => {
    // The type declaration and the doc comment are not part of the fix.
    const text = readFileSync(TARGET, "utf8");
    assert.match(text, /export type Label = Readonly<\{ id: string; text: string \}>;/);
    assert.match(text, /Return the labels in display order: by text, then by id\./);
  });
});

describe("E06 negative controls", () => {
  const reference = (labels: readonly Label[]): readonly Label[] =>
    [...labels].sort((left, right) => {
      const byText = left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
      if (byText !== 0) return byText;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  const passesContract = (
    implementation: (labels: readonly Label[]) => readonly Label[],
  ): boolean => {
    try {
      assert.deepEqual(
        implementation(SAMPLE).map((label) => label.id),
        [...SAMPLE_BY_TEXT],
      );
      const tied: readonly Label[] = [
        { id: "z", text: "same" },
        { id: "a", text: "same" },
      ];
      assert.deepEqual(
        implementation(tied).map((label) => label.id),
        ["a", "z"],
      );
      return true;
    } catch {
      return false;
    }
  };

  it("the reference implementation passes", () => {
    assert.equal(passesContract(reference), true);
  });

  it("rejects: the original defect, sorting by id only", () => {
    assert.equal(
      passesContract((labels) =>
        [...labels].sort((left, right) => left.id.localeCompare(right.id)),
      ),
      false,
    );
  });

  it("rejects: sorting by text only, ignoring the tie", () => {
    assert.equal(
      passesContract((labels) =>
        [...labels].sort((left, right) => left.text.localeCompare(right.text)),
      ),
      false,
    );
  });

  it("rejects: locale collation for text", () => {
    // A locale-aware comparison puts 任务 first, so it fails the code-point contract.
    const localeBased = (labels: readonly Label[]) =>
      [...labels].sort((left, right) => {
        const byText = left.text.localeCompare(right.text);
        if (byText !== 0) return byText;
        return left.id.localeCompare(right.id);
      });
    assert.equal(passesContract(localeBased), false);
  });
});
