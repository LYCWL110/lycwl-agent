import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement, useState } from "react";

import {
  maskSecret,
  SUPPORTED_PROTOCOLS,
  type SupportedProtocol,
} from "../domain/config/provider-config.ts";
import { ConfigChrome, clipText, colorProps, useViewport, type Viewport } from "./chrome.ts";
import { type Capabilities, colorFor, detectCapabilities, rowStyle } from "./palette.ts";

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

export type SetupField = "protocol" | "baseUrl" | "model" | "apiKey" | "credentialRef";

export type SetupDraft = Readonly<{
  protocol?: SupportedProtocol;
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
  capabilities?: Capabilities;
  viewport?: Viewport;
  busy?: boolean;
  saveError?: string | null;
  animated?: boolean;
  onSave: (draft: SetupDraft) => void;
  onDiscard: () => void;
}>;

const FIELD_ORDER: readonly SetupField[] = [
  "protocol",
  "baseUrl",
  "model",
  "credentialRef",
  "apiKey",
];

const FIELD_LABEL: Readonly<Record<SetupField, string>> = {
  protocol: "Protocol",
  baseUrl: "endpoint base URL (https)",
  model: "model id",
  credentialRef: "credential reference name",
  apiKey: "API key",
};
const PROTOCOL_LABEL: Readonly<Record<SupportedProtocol, string>> = {
  anthropic_messages: "Anthropic",
  openai_chat: "OpenAI Chat",
  openai_responses: "Responses",
};

export function SetupScreen(props: SetupProps): ReactElement {
  const [draft, setDraft] = useState<SetupDraft & { protocol: SupportedProtocol }>({
    protocol: props.initial.protocol ?? "anthropic_messages",
    baseUrl: props.initial.baseUrl ?? "https://api.anthropic.com",
    model: props.initial.model ?? "",
    apiKey: "",
    credentialRef: props.initial.credentialRef ?? "provider-main",
  });
  const [focus, setFocus] = useState<SetupField>("protocol");
  const viewport = useViewport(props.viewport);
  const width = Math.max(1, Math.min(84, viewport.columns - 4));
  const capabilities =
    props.capabilities ??
    detectCapabilities({
      noColor: process.env["NO_COLOR"] !== undefined,
      colorterm: process.env["COLORTERM"],
      term: process.env["TERM"],
      force: process.env["LYCWL_COLOR"],
      windowsTerminal: process.env["WT_SESSION"] !== undefined,
    });

  useInput((input, key) => {
    if (props.busy) return;
    if (key.escape) {
      props.onDiscard();
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((current) => nextField(current, key.shift ? -1 : 1));
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
    if (focus === "protocol") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        const delta = key.leftArrow ? -1 : 1;
        setDraft((current) => {
          const index = SUPPORTED_PROTOCOLS.indexOf(current.protocol);
          const next = (index + delta + SUPPORTED_PROTOCOLS.length) % SUPPORTED_PROTOCOLS.length;
          return { ...current, protocol: SUPPORTED_PROTOCOLS[next] ?? "anthropic_messages" };
        });
      }
      return;
    }
    if (key.ctrl && input === "u") {
      setDraft((current) => ({ ...current, [focus]: "" }));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      setDraft((current) => ({ ...current, [focus]: removeLast(current[focus]) }));
      return;
    }
    if (input.length > 0) {
      setDraft((current) => ({ ...current, [focus]: current[focus] + input }));
    }
  });

  return h(
    ConfigChrome,
    { capabilities, viewport, title: "Provider setup", animated: props.animated },
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { dimColor: true }, "tab field · ← → protocol · enter saves · esc discards"),
      ...FIELD_ORDER.map((field) =>
        h(FieldRow, {
          key: field,
          field,
          value: field === "apiKey" ? maskSecret(draft.apiKey) : draft[field],
          focused: focus === field,
          required: !(field === "apiKey" && props.hasStoredCredential),
          error: props.error !== null && props.error.field === field ? props.error.code : null,
          capabilities,
          width,
        }),
      ),
      ...props.warnings.map((warning, index) =>
        h(
          Box,
          { key: `warn-${index}`, marginTop: index === 0 ? 1 : 0 },
          h(Text, colorProps(colorFor("secondary", capabilities)), `warning: ${warning}`),
        ),
      ),
      props.saveError
        ? h(Text, colorProps(colorFor("tertiary", capabilities)), `Save failed: ${props.saveError}`)
        : null,
      props.busy ? h(Text, colorProps(colorFor("secondary", capabilities)), "Saving…") : null,
    ),
  );
}

function FieldRow(props: {
  field: SetupField;
  value: string;
  focused: boolean;
  required: boolean;
  error: string | null;
  capabilities: Capabilities;
  width: number;
}): ReactElement {
  const label =
    props.width < 60
      ? {
          protocol: "Protocol",
          baseUrl: "Base URL",
          model: "Model",
          credentialRef: "Credential",
          apiKey: "API key",
        }[props.field]
      : FIELD_LABEL[props.field];
  const protocolLabel = PROTOCOL_LABEL[props.value as SupportedProtocol];
  const style = rowStyle({
    role: props.focused ? "primary" : "dim",
    focused: props.focused,
    capabilities: props.capabilities,
  });
  return h(
    Box,
    { flexDirection: "column", marginTop: 1, width: props.width },
    h(
      Box,
      { width: props.width },
      h(Text, colorProps(style.color), props.focused ? "▸ " : "  "),
      h(
        Box,
        { width: props.width < 60 ? 14 : 29, flexShrink: 0 },
        h(Text, { bold: props.focused }, clipText(label, props.width < 60 ? 11 : 26)),
        props.required ? h(Text, colorProps(colorFor("tertiary", props.capabilities)), " *") : null,
      ),
      h(
        Text,
        {
          ...colorProps(style.color),
          ...(style.backgroundColor === undefined
            ? {}
            : { backgroundColor: style.backgroundColor }),
          ...(style.inverse ? { inverse: true } : {}),
        },
        clipText(
          props.field === "protocol"
            ? `‹ ${protocolLabel ?? props.value} ›`
            : props.value.length === 0
              ? " "
              : props.value,
          Math.max(1, props.width - (props.width < 60 ? 17 : 32)),
        ),
      ),
      // A caret marks the focused field's insertion point without revealing a
      // masked value.
      props.focused ? h(Text, colorProps(style.color), "_") : null,
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
