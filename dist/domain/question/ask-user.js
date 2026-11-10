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
});
function codePoints(value) {
    return [...value].length;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function validateAskUserQuestion(input) {
    if (!isRecord(input))
        return { ok: false, code: "invalid_question" };
    const question = input["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
        return { ok: false, code: "invalid_question" };
    }
    if (codePoints(question) > QUESTION_LIMITS.maxQuestionCodePoints) {
        return { ok: false, code: "question_too_long" };
    }
    const answerType = input["answerType"];
    if (answerType === "text")
        return { ok: true, question: { answerType: "text", question } };
    if (answerType === "confirmation") {
        return { ok: true, question: { answerType: "confirmation", question } };
    }
    if (answerType !== "choice")
        return { ok: false, code: "invalid_question" };
    const rawOptions = input["options"];
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        return { ok: false, code: "invalid_question" };
    }
    if (rawOptions.length > QUESTION_LIMITS.maxOptions) {
        return { ok: false, code: "too_many_options" };
    }
    const ids = new Set();
    const labels = new Set();
    const options = [];
    for (const raw of rawOptions) {
        if (!isRecord(raw))
            return { ok: false, code: "invalid_question" };
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
        if (ids.has(id))
            return { ok: false, code: "duplicate_option_id" };
        const normalized = label.trim();
        if (labels.has(normalized))
            return { ok: false, code: "duplicate_option_label" };
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
export function validateUserAnswer(question, answer) {
    if (!isRecord(answer))
        return { ok: false, code: "answer_type_mismatch" };
    const kind = answer["kind"];
    if (question.answerType === "confirmation") {
        if (kind !== "confirmation")
            return { ok: false, code: "answer_type_mismatch" };
        const confirmed = answer["confirmed"];
        if (typeof confirmed !== "boolean")
            return { ok: false, code: "answer_type_mismatch" };
        return { ok: true, text: confirmed ? "true" : "false" };
    }
    if (question.answerType === "text") {
        if (kind !== "text")
            return { ok: false, code: "answer_type_mismatch" };
        return validateFreeText(answer["text"]);
    }
    if (kind === "free_text") {
        if (!question.allowFreeText)
            return { ok: false, code: "free_text_not_allowed" };
        return validateFreeText(answer["text"]);
    }
    if (kind !== "choice")
        return { ok: false, code: "answer_type_mismatch" };
    const rawIds = answer["optionIds"];
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
        return { ok: false, code: "answer_type_mismatch" };
    }
    const optionIds = rawIds;
    if (new Set(optionIds).size !== optionIds.length) {
        return { ok: false, code: "duplicate_option" };
    }
    const known = new Set(question.options.map((option) => option.id));
    if (optionIds.some((id) => !known.has(id)))
        return { ok: false, code: "invalid_option" };
    if (question.multiple) {
        if (optionIds.length < 1 || optionIds.length > QUESTION_LIMITS.maxOptions) {
            return { ok: false, code: "invalid_option_count" };
        }
    }
    else if (optionIds.length !== 1) {
        return { ok: false, code: "invalid_option_count" };
    }
    // Return both the id and the label. The id alone is opaque to the model: seeing
    // `["a"]` tells it nothing about what the user chose, so the answer must carry
    // the text the user actually saw.
    const selected = optionIds.map((id) => {
        const option = question.options.find((candidate) => candidate.id === id);
        return option === undefined ? { id, label: id } : { id, label: option.label };
    });
    return {
        ok: true,
        text: selected.length === 1 ? (selected[0]?.label ?? "") : JSON.stringify({ selected }),
    };
}
function validateFreeText(value) {
    if (typeof value !== "string")
        return { ok: false, code: "answer_type_mismatch" };
    if (value.trim().length === 0)
        return { ok: false, code: "empty_answer" };
    if (codePoints(value) > QUESTION_LIMITS.maxAnswerCodePoints) {
        return { ok: false, code: "answer_too_long" };
    }
    return { ok: true, text: value };
}
export function questionOutcome(status, answerText) {
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
