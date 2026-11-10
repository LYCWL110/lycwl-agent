import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QUESTION_LIMITS,
  questionOutcome,
  validateAskUserQuestion,
  validateUserAnswer,
} from "../../src/domain/question/ask-user.ts";

function choiceQuestion(overrides: Record<string, unknown> = {}) {
  const validated = validateAskUserQuestion({
    answerType: "choice",
    question: "Which file should I edit?",
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    ...overrides,
  });
  if (!validated.ok) throw new Error(validated.code);
  return validated.question;
}

describe("ask_user question validation", () => {
  it("accepts text, confirmation and choice shapes", () => {
    assert.deepEqual(validateAskUserQuestion({ answerType: "text", question: "Name?" }), {
      ok: true,
      question: { answerType: "text", question: "Name?" },
    });
    assert.deepEqual(
      validateAskUserQuestion({ answerType: "confirmation", question: "Proceed?" }),
      { ok: true, question: { answerType: "confirmation", question: "Proceed?" } },
    );
    const choice = choiceQuestion();
    assert.equal(choice.answerType, "choice");
    if (choice.answerType !== "choice") return;
    assert.equal(choice.multiple, false);
    assert.equal(choice.allowFreeText, false);
    assert.equal(choice.options.length, 2);
  });

  it("rejects empty, over-long and unknown answer types", () => {
    assert.deepEqual(validateAskUserQuestion({ answerType: "text", question: "  " }), {
      ok: false,
      code: "invalid_question",
    });
    assert.deepEqual(
      validateAskUserQuestion({
        answerType: "text",
        question: "x".repeat(QUESTION_LIMITS.maxQuestionCodePoints + 1),
      }),
      { ok: false, code: "question_too_long" },
    );
    assert.deepEqual(validateAskUserQuestion({ answerType: "ranking", question: "Q" }), {
      ok: false,
      code: "invalid_question",
    });
    assert.deepEqual(validateAskUserQuestion(null), { ok: false, code: "invalid_question" });
  });

  it("rejects too many, duplicate and empty option entries", () => {
    const tooMany = Array.from({ length: QUESTION_LIMITS.maxOptions + 1 }, (_, index) => ({
      id: `o${index}`,
      label: `L${index}`,
    }));
    assert.deepEqual(
      validateAskUserQuestion({ answerType: "choice", question: "Q", options: tooMany }),
      {
        ok: false,
        code: "too_many_options",
      },
    );
    assert.deepEqual(
      validateAskUserQuestion({
        answerType: "choice",
        question: "Q",
        options: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      }),
      { ok: false, code: "duplicate_option_id" },
    );
    assert.deepEqual(
      validateAskUserQuestion({
        answerType: "choice",
        question: "Q",
        options: [
          { id: "a", label: "Same" },
          { id: "b", label: "  Same  " },
        ],
      }),
      { ok: false, code: "duplicate_option_label" },
    );
    assert.deepEqual(
      validateAskUserQuestion({
        answerType: "choice",
        question: "Q",
        options: [{ id: "a", label: "   " }],
      }),
      { ok: false, code: "invalid_option_label" },
    );
  });
});

describe("ask_user answer validation", () => {
  it("requires exactly one option for a single-choice question", () => {
    const question = choiceQuestion();
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: [] }), {
      ok: false,
      code: "invalid_option_count",
    });
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: ["a", "b"] }), {
      ok: false,
      code: "invalid_option_count",
    });
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: ["a"] }), {
      ok: true,
      text: "Alpha",
    });
  });

  it("accepts 1..8 unique options for a multiple-choice question", () => {
    const question = choiceQuestion({ multiple: true });
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: ["a", "b"] }), {
      ok: true,
      text: JSON.stringify({
        selected: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      }),
    });
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: ["a", "a"] }), {
      ok: false,
      code: "duplicate_option",
    });
    assert.deepEqual(validateUserAnswer(question, { kind: "choice", optionIds: ["zzz"] }), {
      ok: false,
      code: "invalid_option",
    });
  });

  it("requires free text to be allowed and non-blank", () => {
    const strict = choiceQuestion();
    assert.deepEqual(validateUserAnswer(strict, { kind: "free_text", text: "custom" }), {
      ok: false,
      code: "free_text_not_allowed",
    });
    const open = choiceQuestion({ allowFreeText: true });
    assert.deepEqual(validateUserAnswer(open, { kind: "free_text", text: "custom" }), {
      ok: true,
      text: "custom",
    });
    assert.deepEqual(validateUserAnswer(open, { kind: "free_text", text: "   " }), {
      ok: false,
      code: "empty_answer",
    });
    assert.deepEqual(
      validateUserAnswer(open, {
        kind: "free_text",
        text: "x".repeat(QUESTION_LIMITS.maxAnswerCodePoints + 1),
      }),
      { ok: false, code: "answer_too_long" },
    );
  });

  it("rejects answer forms that do not match the question type", () => {
    const text = validateAskUserQuestion({ answerType: "text", question: "Name?" });
    assert.equal(text.ok, true);
    if (!text.ok) return;
    assert.deepEqual(validateUserAnswer(text.question, { kind: "choice", optionIds: ["a"] }), {
      ok: false,
      code: "answer_type_mismatch",
    });
    const confirmation = validateAskUserQuestion({
      answerType: "confirmation",
      question: "Proceed?",
    });
    assert.equal(confirmation.ok, true);
    if (!confirmation.ok) return;
    assert.deepEqual(validateUserAnswer(confirmation.question, { kind: "text", text: "yes" }), {
      ok: false,
      code: "answer_type_mismatch",
    });
    assert.deepEqual(
      validateUserAnswer(confirmation.question, { kind: "confirmation", confirmed: true }),
      { ok: true, text: "true" },
    );
  });
});

describe("question outcome projection", () => {
  it("maps each terminal state to a distinct tool result", () => {
    assert.deepEqual(questionOutcome("answered", "answer"), {
      status: "answered",
      toolStatus: "succeeded",
      text: "answer",
    });
    assert.deepEqual(questionOutcome("declined", null), {
      status: "declined",
      toolStatus: "failed",
      safeCode: "question_declined",
    });
    assert.deepEqual(questionOutcome("cancelled", null), {
      status: "cancelled",
      toolStatus: "cancelled",
      safeCode: "question_cancelled",
    });
    assert.deepEqual(questionOutcome("unavailable", null), {
      status: "unavailable",
      toolStatus: "failed",
      safeCode: "question_unavailable",
    });
  });
});
