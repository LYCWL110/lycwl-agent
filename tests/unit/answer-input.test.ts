import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAnswer } from "../../src/tui/answer-input.ts";

const CHOICE = {
  answerType: "choice" as const,
  multiple: false,
  allowFreeText: false,
  options: [
    { id: "a", label: "src/a.ts" },
    { id: "b", label: "src/b.ts" },
  ],
};

const MULTI = { ...CHOICE, multiple: true };

describe("choice answers accept an id or a label", () => {
  it("accepts an option id", () => {
    assert.deepEqual(resolveAnswer(CHOICE, "a"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["a"] },
    });
  });

  it("accepts the visible label", () => {
    // The panel shows the label, so typing it must work. The earlier behaviour
    // passed the raw text as an id and rejected this.
    assert.deepEqual(resolveAnswer(CHOICE, "src/b.ts"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["b"] },
    });
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(resolveAnswer(CHOICE, "  src/a.ts  "), {
      ok: true,
      answer: { kind: "choice", optionIds: ["a"] },
    });
  });

  it("prefers an exact id over a label that contains it", () => {
    const question = {
      ...CHOICE,
      options: [
        { id: "a", label: "a" },
        { id: "z", label: "option a" },
      ],
    };
    assert.deepEqual(resolveAnswer(question, "a"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["a"] },
    });
  });

  it("rejects an unknown option and says what was not found", () => {
    const result = resolveAnswer(CHOICE, "nope");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "unknown_option");
    assert.match(result.detail, /nope/);
  });

  it("rejects an empty answer", () => {
    const result = resolveAnswer(CHOICE, "   ");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "empty");
  });
});

describe("ambiguous labels are rejected rather than guessed", () => {
  it("refuses when two options share a label", () => {
    const question = {
      ...CHOICE,
      options: [
        { id: "a", label: "same" },
        { id: "b", label: "same" },
      ],
    };
    const result = resolveAnswer(question, "same");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "ambiguous_option");
    assert.match(result.detail, /a, b/);
  });

  it("accepts the id when the label is ambiguous", () => {
    const question = {
      ...CHOICE,
      options: [
        { id: "a", label: "same" },
        { id: "b", label: "same" },
      ],
    };
    assert.deepEqual(resolveAnswer(question, "b"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["b"] },
    });
  });
});

describe("multiple choice", () => {
  it("accepts a comma-separated list of labels", () => {
    assert.deepEqual(resolveAnswer(MULTI, "src/a.ts, src/b.ts"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["a", "b"] },
    });
  });

  it("accepts a mix of ids and labels", () => {
    assert.deepEqual(resolveAnswer(MULTI, "a, src/b.ts"), {
      ok: true,
      answer: { kind: "choice", optionIds: ["a", "b"] },
    });
  });

  it("rejects a repeated selection instead of deduplicating silently", () => {
    const result = resolveAnswer(MULTI, "a, a");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "ambiguous_option");
  });
});

describe("confirmation answers", () => {
  const confirmation = {
    answerType: "confirmation" as const,
    multiple: false,
    allowFreeText: false,
    options: [],
  };

  it("accepts yes variants", () => {
    for (const text of ["y", "YES", "true", "1"]) {
      assert.deepEqual(resolveAnswer(confirmation, text), {
        ok: true,
        answer: { kind: "confirmation", confirmed: true },
      });
    }
  });

  it("accepts no variants", () => {
    for (const text of ["n", "No", "false", "0"]) {
      assert.deepEqual(resolveAnswer(confirmation, text), {
        ok: true,
        answer: { kind: "confirmation", confirmed: false },
      });
    }
  });

  it("rejects anything else and states the expected input", () => {
    const result = resolveAnswer(confirmation, "maybe");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "unknown_option");
    assert.match(result.detail, /yes/);
  });
});

describe("free text answers", () => {
  it("passes text through for a text question", () => {
    const question = {
      answerType: "text" as const,
      multiple: false,
      allowFreeText: false,
      options: [],
    };
    assert.deepEqual(resolveAnswer(question, "  hello there  "), {
      ok: true,
      answer: { kind: "text", text: "hello there" },
    });
  });

  it("treats an unmatched entry as free text when allowed", () => {
    const question = { ...CHOICE, allowFreeText: true };
    assert.deepEqual(resolveAnswer(question, "something else"), {
      ok: true,
      answer: { kind: "text", text: "something else" },
    });
  });
});
