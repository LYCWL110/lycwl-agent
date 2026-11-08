import { Box, Text, useInput, usePaste } from "ink";
import { createElement as h, type ReactElement, useState } from "react";
import { clipText, colorProps, type Viewport, wrapText } from "./chrome.ts";
import { type Capabilities, colorFor } from "./palette.ts";
import { editText, type TextEdit } from "./text-edit.ts";
import { TextInput } from "./text-input.ts";
import { COMPOSER_COMMANDS } from "./view-model.ts";

export function LocalPanel(props: {
  kind: "help" | "session";
  sessionId?: string | undefined;
  notice?: string | null | undefined;
  viewport: Viewport;
  capabilities: Capabilities;
  onSubmit: (text: string) => void;
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);
  const [resume, setResume] = useState<TextEdit | null>(null);
  const [offset, setOffset] = useState(0);
  const width = Math.max(1, props.viewport.columns - 4);
  const rows = Math.max(1, props.viewport.rows - 6);
  const helpLines = [
    ...COMPOSER_COMMANDS.map((command) => `${command.name}  ${command.description}`),
    "/session new  Start a fresh session",
    "/session resume <id>  Resume recorded context",
    "Click tool row / Ctrl+T  Toggle tool details",
  ].flatMap((text) => wrapText(text, width));
  useInput((input, key) => {
    if (key.escape) {
      if (resume !== null) setResume(null);
      else props.onClose();
      return;
    }
    if (key.ctrl && input === "c") {
      props.onSubmit("/cancel");
      return;
    }
    if (props.kind === "help") {
      if (key.return) props.onClose();
      if (key.downArrow || key.pageDown)
        setOffset((value) => Math.min(Math.max(0, helpLines.length - rows), value + 1));
      if (key.upArrow || key.pageUp) setOffset((value) => Math.max(0, value - 1));
      return;
    }
    if (resume !== null) {
      if (key.return) {
        if (resume.value.trim()) props.onSubmit(`/session resume ${resume.value.trim()}`);
      } else {
        const edited = editText(resume, input, key);
        if (edited.value.length <= 80) setResume(edited);
      }
      return;
    }
    if (key.upArrow || key.downArrow) setSelected((value) => (value + (key.upArrow ? 2 : 1)) % 3);
    if (key.return) {
      if (selected === 0) props.onClose();
      if (selected === 1) props.onSubmit("/new");
      if (selected === 2) setResume({ value: "", cursor: 0 });
    }
  });
  usePaste((text) => {
    if (resume === null) return;
    const edited = editText(resume, text, {});
    if (edited.value.length <= 80) setResume(edited);
  });
  return h(
    Box,
    {
      width: props.viewport.columns,
      height: Math.max(1, props.viewport.rows - 1),
      flexDirection: "column",
      paddingX: 2,
      overflow: "hidden",
    },
    h(
      Text,
      { bold: true, ...colorProps(colorFor("primary", props.capabilities)) },
      props.kind === "help" ? "Commands" : "Session",
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      ...(props.kind === "help"
        ? helpLines.slice(offset, offset + rows).map((line, index) => h(Text, { key: index }, line))
        : [
            h(
              Text,
              { key: "id", wrap: "wrap", ...colorProps(colorFor("dim", props.capabilities)) },
              `Current: ${props.sessionId ?? "unavailable"}`,
            ),
            ...["Keep current session", "New session", "Resume by ID"].map((label, index) =>
              h(
                Text,
                {
                  key: label,
                  inverse: selected === index && resume === null,
                },
                clipText(`${selected === index ? ">" : " "} ${label}`, width),
              ),
            ),
            resume === null
              ? null
              : h(
                  Box,
                  { key: "input" },
                  h(Text, null, "ID: "),
                  h(TextInput, { ...resume, width: Math.max(1, width - 4) }),
                ),
          ]),
    ),
    h(
      Text,
      colorProps(colorFor("tertiary", props.capabilities)),
      clipText(props.notice ?? "", width),
    ),
    h(
      Text,
      colorProps(colorFor("dim", props.capabilities)),
      clipText(props.kind === "help" ? "Enter / Esc close" : "Enter select  Esc back", width),
    ),
  );
}
