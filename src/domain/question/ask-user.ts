/**
 * One correlated ask_user question per invocation (ADR-0014 section 1). Bounds
 * and validation are confirmed behavior; this module is pure and grants no
 * authority. Closing a question panel is a view event, not an answer.
 */
export const QUESTION_LIMITS = Object.freeze({
  maxQuestionCodePoints: 4_000,
  maxLabelCodePoints: 200,
  maxAnswerCodePoints: 4_000,
  maxOptions: 8,
} as const);

export type QuestionOption = Readonly<{
  id: string;
  label: string;
}>;

export type AskUserQuestion =
  | Readonly<{
      answerType: "choice";
      question: string;
      options: readonly QuestionOption[];
      multiple: boolean;
      allowFreeText: boolean;
    }>
  | Readonly<{
      answerType: "text";
      question: string;
    }>
  | Readonly<{
      answerType: "confirmation";
      question: string;
    }>;

export type AskUserFailure =
  | "invalid_question"
  | "question_too_long"
  | "too_many_options"
  | "duplicate_option_id"
  | "duplicate_option_label"
  | "invalid_option_label";

export type AskUserValidation =
  | Readonly<{ ok: true; question: AskUserQuestion }>
  | Readonly<{ ok: false; code: AskUserFailure }>;

function codePoints(value: string): number {
  return [...value].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateAskUserQuestion(input: unknown): AskUserValidation {
  if (!isRecord(input)) return { ok: false, code: "invalid_question" };
  const question = input["question"];
  if (typeof question !== "string" || question.trim().length === 0) {
    return { ok: false, code: "invalid_question" };
  }
  if (codePoints(question) > QUESTION_LIMITS.maxQuestionCodePoints) {
    return { ok: false, code: "question_too_long" };
  }
  const answerType = input["answerType"];
  if (answerType === "text") return { ok: true, question: { answerType: "text", question } };
  if (answerType === "confirmation") {
    return { ok: true, question: { answerType: "confirmation", question } };
  }
  if (answerType !== "choice") return { ok: false, code: "invalid_question" };

  const rawOptions = input["options"];
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return { ok: false, code: "invalid_question" };
  }
  if (rawOptions.length > QUESTION_LIMITS.maxOptions) {
    return { ok: false, code: "too_many_options" };
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const options: QuestionOption[] = [];
  for (const raw of rawOptions) {
    if (!isRecord(raw)) return { ok: false, code: "invalid_question" };
    const id = raw["id"];
    const label = raw["label"];
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, code: "invalid_question" };
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      return { ok: false, code: "invalid_option_label" };
    }
    if (codePoints(label) > QUESTION_LIMITS.maxLabelCodePoints) {
      return { ok: false, code: "invalid_option_label" };
    }
    if (ids.has(id)) return { ok: false, code: "duplicate_option_id" };
    const normalized = label.trim();
    if (labels.has(normalized)) return { ok: false, code: "duplicate_option_label" };
    ids.add(id);
    labels.add(normalized);
    options.push({ id, label });
  }

  return {
    ok: true,
    question: {
      answerType: "choice",
      question,
      options,
      multiple: input["multiple"] === true,
      allowFreeText: input["allowFreeText"] === true,
    },
  };
}

export type UserAnswer =
  | Readonly<{ kind: "choice"; optionIds: readonly string[] }>
  | Readonly<{ kind: "free_text"; text: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "confirmation"; confirmed: boolean }>;

export type AnswerFailure =
  | "answer_type_mismatch"
  | "invalid_option"
  | "invalid_option_count"
  | "duplicate_option"
  | "free_text_not_allowed"
  | "empty_answer"
  | "answer_too_long"
  | "mixed_answer_forms";

export type AnswerValidation =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; code: AnswerFailure }>;

export function validateUserAnswer(question: AskUserQuestion, answer: unknown): AnswerValidation {
  if (!isRecord(answer)) return { ok: false, code: "answer_type_mismatch" };
  const kind = answer["kind"];

  if (question.answerType === "confirmation") {
    if (kind !== "confirmation") return { ok: false, code: "answer_type_mismatch" };
    const confirmed = answer["confirmed"];
    if (typeof confirmed !== "boolean") return { ok: false, code: "answer_type_mismatch" };
    return { ok: true, text: confirmed ? "true" : "false" };
  }

  if (question.answerType === "text") {
    if (kind !== "text") return { ok: false, code: "answer_type_mismatch" };
    return validateFreeText(answer["text"]);
  }

  if (kind === "free_text") {
    if (!question.allowFreeText) return { ok: false, code: "free_text_not_allowed" };
    return validateFreeText(answer["text"]);
  }
  if (kind !== "choice") return { ok: false, code: "answer_type_mismatch" };

  const rawIds = answer["optionIds"];
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
    return { ok: false, code: "answer_type_mismatch" };
  }
  const optionIds = rawIds as readonly string[];
  if (new Set(optionIds).size !== optionIds.length) {
    return { ok: false, code: "duplicate_option" };
  }
  const known = new Set(question.options.map((option) => option.id));
  if (optionIds.some((id) => !known.has(id))) return { ok: false, code: "invalid_option" };

  if (question.multiple) {
    if (optionIds.length < 1 || optionIds.length > QUESTION_LIMITS.maxOptions) {
      return { ok: false, code: "invalid_option_count" };
    }
  } else if (optionIds.length !== 1) {
    return { ok: false, code: "invalid_option_count" };
  }

  return { ok: true, text: JSON.stringify({ optionIds }) };
}

function validateFreeText(value: unknown): AnswerValidation {
  if (typeof value !== "string") return { ok: false, code: "answer_type_mismatch" };
  if (value.trim().length === 0) return { ok: false, code: "empty_answer" };
  if (codePoints(value) > QUESTION_LIMITS.maxAnswerCodePoints) {
    return { ok: false, code: "answer_too_long" };
  }
  return { ok: true, text: value };
}

/**
 * Terminal projection of one question. Only an answer is a successful tool
 * result; decline is a failure, cancel is a tool cancellation, and an
 * unavailable channel is a failure. None of them implies approval.
 */
export type QuestionOutcome =
  | Readonly<{ status: "answered"; toolStatus: "succeeded"; text: string }>
  | Readonly<{ status: "declined"; toolStatus: "failed"; safeCode: "question_declined" }>
  | Readonly<{ status: "cancelled"; toolStatus: "cancelled"; safeCode: "question_cancelled" }>
  | Readonly<{
      status: "unavailable";
      toolStatus: "failed";
      safeCode: "question_unavailable";
    }>;

export function questionOutcome(
  status: QuestionOutcome["status"],
  answerText: string | null,
): QuestionOutcome {
  switch (status) {
    case "answered":
      return { status: "answered", toolStatus: "succeeded", text: answerText ?? "" };
    case "declined":
      return { status: "declined", toolStatus: "failed", safeCode: "question_declined" };
    case "cancelled":
      return { status: "cancelled", toolStatus: "cancelled", safeCode: "question_cancelled" };
    case "unavailable":
      return { status: "unavailable", toolStatus: "failed", safeCode: "question_unavailable" };
  }
}
