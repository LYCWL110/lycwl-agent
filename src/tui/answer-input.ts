/**
 * Map composer text to a typed answer.
 *
 * The panel shows `id) label`, so a user reasonably types either. Passing the raw
 * text as an option id — the previous behaviour — meant typing the visible label
 * produced `invalid_option` with no explanation, and typing `a` worked only because
 * the id happened to match.
 *
 * Resolution is deliberately strict: an ambiguous match is rejected rather than
 * guessed, because picking one of two matching labels would record an answer the
 * user did not give.
 */

export type QuestionAnswerInput = Readonly<{
  answerType: "choice" | "text" | "confirmation";
  multiple: boolean;
  allowFreeText: boolean;
  options: readonly Readonly<{ id: string; label: string }>[];
}>;

export type ResolvedAnswer =
  | Readonly<{ kind: "choice"; optionIds: readonly string[] }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "confirmation"; confirmed: boolean }>;

export type AnswerResolution =
  | Readonly<{ ok: true; answer: ResolvedAnswer }>
  | Readonly<{
      ok: false;
      reason: "empty" | "unknown_option" | "ambiguous_option" | "free_text_not_allowed";
      detail: string;
    }>;

const CONFIRM_YES: ReadonlySet<string> = new Set(["y", "yes", "true", "1"]);
const CONFIRM_NO: ReadonlySet<string> = new Set(["n", "no", "false", "0"]);

/**
 * Resolve composer text for the pending question.
 *
 * Choice answers accept a comma-separated list of ids or labels when the question
 * allows multiple selections; a single-choice question accepts exactly one.
 */
export function resolveAnswer(question: QuestionAnswerInput, text: string): AnswerResolution {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", detail: "type an answer" };
  }

  if (question.answerType === "confirmation") {
    const lowered = trimmed.toLowerCase();
    if (CONFIRM_YES.has(lowered))
      return { ok: true, answer: { kind: "confirmation", confirmed: true } };
    if (CONFIRM_NO.has(lowered))
      return { ok: true, answer: { kind: "confirmation", confirmed: false } };
    return {
      ok: false,
      reason: "unknown_option",
      detail: 'answer "yes" or "no"',
    };
  }

  if (question.answerType === "text") {
    return { ok: true, answer: { kind: "text", text: trimmed } };
  }

  // choice
  const parts = question.multiple
    ? trimmed
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [trimmed];

  if (parts.length === 0) return { ok: false, reason: "empty", detail: "type an answer" };

  const resolved: string[] = [];
  for (const part of parts) {
    const match = matchOption(question.options, part);
    if (match.kind === "none") {
      // A question that allows free text treats an unmatched entry as text, but only
      // when it is not a single-choice question expecting one of the listed options.
      if (question.allowFreeText && !question.multiple) {
        return { ok: true, answer: { kind: "text", text: trimmed } };
      }
      return {
        ok: false,
        reason: "unknown_option",
        detail: `no option matches "${part}"`,
      };
    }
    if (match.kind === "ambiguous") {
      return {
        ok: false,
        reason: "ambiguous_option",
        detail: `"${part}" matches ${match.ids.join(", ")}; type the id`,
      };
    }
    resolved.push(match.id);
  }

  // A repeated selection is a user mistake, not something to silently deduplicate:
  // recording it as one choice would misreport what was typed.
  if (new Set(resolved).size !== resolved.length) {
    return { ok: false, reason: "ambiguous_option", detail: "the same option was given twice" };
  }
  return { ok: true, answer: { kind: "choice", optionIds: resolved } };
}

type OptionMatch =
  | Readonly<{ kind: "one"; id: string }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "ambiguous"; ids: readonly string[] }>;

function matchOption(
  options: readonly Readonly<{ id: string; label: string }>[],
  text: string,
): OptionMatch {
  // An exact id wins outright, so an id that also appears inside a label is never
  // shadowed by the label match.
  const byId = options.find((option) => option.id === text);
  if (byId !== undefined) return { kind: "one", id: byId.id };

  const byLabel = options.filter((option) => option.label === text);
  if (byLabel.length === 1) {
    const match = byLabel[0];
    return match === undefined ? { kind: "none" } : { kind: "one", id: match.id };
  }
  if (byLabel.length > 1) {
    return { kind: "ambiguous", ids: byLabel.map((option) => option.id) };
  }
  return { kind: "none" };
}
