import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement, useState } from "react";

import { maskSecret } from "../domain/config/provider-config.ts";

/**
 * First-time setup screen (S02 "初次设置").
 *
 * Rules this screen follows:
 * - the key input never echoes, and the stored key is never displayed;
 * - save and discard are separate, explicit actions;
 * - a validation error is shown against the field, and the draft is kept;
 * - this screen performs no I/O. It reports a draft upward; the caller decides
 *   whether to write it.
 */

const h = createElement;

export type SetupField = "baseUrl" | "model" | "apiKey" | "credentialRef";

export type SetupDraft = Readonly<{
  baseUrl: string;
  model: string;
  apiKey: string;
  credentialRef: string;
}>;

export type SetupProps = Readonly<{
  initial: Partial<SetupDraft>;
  /** True when a credential already exists; the key field is then optional. */
  hasStoredCredential: boolean;
  /** Last validation failure, if any. */
  error: Readonly<{ field: SetupField; code: string }> | null;
  /** Non-fatal warnings, e.g. plaintext storage. */
  warnings: readonly string[];
  onSave: (draft: SetupDraft) => void;
  onDiscard: () => void;
}>;

const FIELD_ORDER: readonly SetupField[] = ["baseUrl", "model", "credentialRef", "apiKey"];

const FIELD_LABEL: Readonly<Record<SetupField, string>> = {
  baseUrl: "endpoint base URL (https)",
  model: "model id",
  credentialRef: "credential reference name",
  apiKey: "API key",
};

export function SetupScreen(props: SetupProps): ReactElement {
  const [draft, setDraft] = useState<SetupDraft>({
    baseUrl: props.initial.baseUrl ?? "https://api.anthropic.com",
    model: props.initial.model ?? "",
    apiKey: "",
    credentialRef: props.initial.credentialRef ?? "provider-main",
  });
  const [focus, setFocus] = useState<SetupField>("baseUrl");

  useInput((input, key) => {
    if (key.escape) {
      props.onDiscard();
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((current) => nextField(current, 1));
      return;
    }
    if (key.upArrow) {
      setFocus((current) => nextField(current, -1));
      return;
    }
    if (key.return) {
      props.onSave(draft);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((current) => ({ ...current, [focus]: removeLast(current[focus]) }));
      return;
    }
    if (input.length > 0) {
      setDraft((current) => ({ ...current, [focus]: current[focus] + input }));
    }
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Provider setup"),
    h(Text, { dimColor: true }, "tab/up/down moves between fields - enter saves - esc discards"),
    ...FIELD_ORDER.map((field) =>
      h(FieldRow, {
        key: field,
        field,
        value: field === "apiKey" ? maskSecret(draft.apiKey) : draft[field],
        focused: focus === field,
        required: !(field === "apiKey" && props.hasStoredCredential),
        error: props.error !== null && props.error.field === field ? props.error.code : null,
      }),
    ),
    ...props.warnings.map((warning, index) =>
      h(
        Box,
        { key: `warn-${index}`, marginTop: index === 0 ? 1 : 0 },
        h(Text, { color: "yellow" }, `warning: ${warning}`),
      ),
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { dimColor: true }, "the key is written to the credential vault, never to settings"),
    ),
  );
}

function FieldRow(props: {
  field: SetupField;
  value: string;
  focused: boolean;
  required: boolean;
  error: string | null;
}): ReactElement {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Box,
      null,
      h(Text, props.focused ? { color: "cyan" } : {}, props.focused ? "> " : "  "),
      h(Text, { bold: props.focused }, FIELD_LABEL[props.field]),
      props.required ? h(Text, { color: "red" }, " *") : null,
    ),
    h(
      Box,
      { marginLeft: 2 },
      h(Text, null, props.value.length === 0 ? " " : props.value),
      // A caret marks the focused field's insertion point without revealing a
      // masked value.
      props.focused ? h(Text, { color: "cyan" }, "_") : null,
    ),
    props.error === null
      ? null
      : h(Box, { marginLeft: 2 }, h(Text, { color: "red" }, `invalid: ${props.error}`)),
  );
}

function nextField(current: SetupField, delta: number): SetupField {
  const index = FIELD_ORDER.indexOf(current);
  const next = (index + delta + FIELD_ORDER.length) % FIELD_ORDER.length;
  return FIELD_ORDER[next] ?? "baseUrl";
}

function removeLast(value: string): string {
  return [...value].slice(0, -1).join("");
}
