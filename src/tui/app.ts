import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement, useState } from "react";
import { Brand, clipText, colorProps, useViewport, type Viewport, wrapText } from "./chrome.ts";
import { type Capabilities, colorFor, detectCapabilities } from "./palette.ts";
import { editText, type TextEdit } from "./text-edit.ts";
import { TextInput } from "./text-input.ts";
import type { TuiViewState } from "./view-model.ts";

/**
 * Main TUI layout, following the Miyu reference's structure.
 *
 * The reference's shape, which this reproduces with Ink:
 *
 * - a message area with a per-entry gutter, so a role is visible without reading;
 * - an input box with a **coloured bar on its left edge** carrying the lane accent;
 * - a single footer line: mode label, model, then status on the right;
 * - the same accent colour for the input bar, the mode label and the goal line, so
 *   the corners of the screen agree.
 *
 * Differences are deliberate: there is no persona lane, no thinking variant and no
 * token meter, because this Harness has none of those concepts.
 */

const h = createElement;

export type AppProps = Readonly<{
  view: TuiViewState;
  onSubmit: (text: string) => void;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (text: string) => void;
  onDeclineQuestion: () => void;
  onCancelRun: () => void;
  onQuit: () => void;
  /** Injected so a test can exercise every colour depth. */
  capabilities?: Capabilities;
  /** Model name for the footer; absent hides that segment. */
  modelLabel?: string;
  modeLabel?: string;
  viewport?: Viewport;
  animated?: boolean;
}>;

export function App(props: AppProps): ReactElement {
  const { view } = props;
  const [editor, setEditor] = useState<TextEdit>({ value: "", cursor: 0 });
  const draft = editor.value;
  const [scroll, setScroll] = useState(0);
  const viewport = useViewport(props.viewport);
  const width = Math.max(1, viewport.columns - 4);
  const bodyRows = Math.max(3, viewport.rows - 9);
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
    if (key.ctrl && input === "c") {
      props.onCancelRun();
      return;
    }
    if (key.escape) {
      props.onQuit();
      return;
    }
    if (key.pageUp) {
      setScroll((current) => current + Math.max(1, bodyRows - 1));
      return;
    }
    if (key.pageDown) {
      setScroll((current) => Math.max(0, current - Math.max(1, bodyRows - 1)));
      return;
    }
    if (key.return) {
      const text = draft.trim();
      setEditor({ value: "", cursor: 0 });
      setScroll(0);
      if (text.length === 0) return;
      if (view.pendingQuestion !== null) props.onAnswer(text);
      else if (view.pendingApproval !== null) {
        if (text === "a" && view.pendingApprovalPreview !== null) props.onApprove();
        else if (text === "d") props.onDeny();
      } else props.onSubmit(text);
      return;
    }
    setEditor((current) => editText(current, input, key));
  });

  const lobby = view.runStatus === "idle" && view.transcript.length === 0 && view.todo === null;
  if (lobby) {
    const lobbyWidth = Math.max(1, Math.min(84, Math.max(50, Math.floor((width * 2) / 3)), width));
    return h(
      Box,
      {
        width: viewport.columns,
        minHeight: Math.max(1, viewport.rows - 1),
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      },
      h(Brand, {
        capabilities,
        width: lobbyWidth,
        compact: viewport.rows < 20,
        animated: props.animated,
      }),
      h(
        Box,
        { width: lobbyWidth, flexDirection: "column", marginTop: 1 },
        h(Composer, { view, editor, capabilities, width: lobbyWidth }),
        h(Footer, {
          view,
          capabilities,
          modelLabel: props.modelLabel,
          modeLabel: props.modeLabel,
          width: lobbyWidth,
        }),
      ),
      h(
        Box,
        { marginTop: 1 },
        h(Text, colorProps(colorFor("dim", capabilities)), "lycwl  ·  0.1.0"),
      ),
    );
  }
  const lines = documentLines(view, width);
  const offset = Math.min(scroll, Math.max(0, lines.length - bodyRows));
  const start = Math.max(0, lines.length - bodyRows - offset);
  return h(
    Box,
    {
      flexDirection: "column",
      width: viewport.columns,
      minHeight: Math.max(1, viewport.rows - 1),
      paddingX: 2,
    },
    h(TitleBar, { view, capabilities }),
    h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(width)),
    h(
      Box,
      { flexDirection: "column", height: bodyRows, flexShrink: 0 },
      ...lines.slice(start, start + bodyRows).map((line, index) =>
        h(
          Text,
          {
            key: `${start + index}`,
            ...colorProps(colorFor(line.role, capabilities)),
            ...(line.bold ? { bold: true } : {}),
          },
          line.text || " ",
        ),
      ),
    ),
    h(
      Text,
      colorProps(colorFor("faint", capabilities)),
      lines.length > bodyRows
        ? `${start + 1}–${Math.min(start + bodyRows, lines.length)} / ${lines.length}  ·  PgUp / PgDn`
        : "─".repeat(width),
    ),
    h(Composer, { view, editor, capabilities, width }),
    h(Footer, {
      view,
      capabilities,
      modelLabel: props.modelLabel,
      modeLabel: props.modeLabel,
      width,
    }),
  );
}

type DocumentLine = Readonly<{
  text: string;
  role: "primary" | "secondary" | "tertiary" | "success" | "dim" | "faint";
  bold?: boolean;
}>;

/** Wrap rather than truncate: approval commands and diffs remain available by paging. */
function documentLines(view: TuiViewState, width: number): DocumentLine[] {
  const lines: DocumentLine[] = [];
  function append(text: string, role: DocumentLine["role"], bold = false): void {
    lines.push(...wrapText(text, width).map((line) => ({ text: line, role, bold })));
  }
  for (const entry of view.transcript) {
    const role =
      entry.kind === "user"
        ? "primary"
        : entry.kind === "assistant"
          ? "success"
          : entry.status === "failed" || entry.status === "denied"
            ? "tertiary"
            : "dim";
    const label =
      entry.kind === "user"
        ? "you"
        : entry.kind === "assistant"
          ? "agent"
          : entry.kind === "tool"
            ? `tool${entry.status === null ? "" : `·${entry.status}`}`
            : "sys";
    append(`▌ ${label}`, role, true);
    append(entry.text, "dim");
    append("", "faint");
  }
  if (view.todo !== null) {
    append("plan", "secondary", true);
    for (const item of view.todo.items)
      append(
        `${marker(item.state)} ${item.content}`,
        item.state === "completed" ? "success" : "dim",
      );
  }
  if (view.pendingApproval !== null) {
    append(`▌ approval required · ${view.pendingApproval.toolName}`, "secondary", true);
    if (view.pendingApprovalPreview === null)
      append("preview unavailable: the exact operation is not recorded", "tertiary");
    else for (const line of view.pendingApprovalPreview) append(line, "dim");
    append(
      view.pendingApprovalPreview === null
        ? 'type "d" then Enter to deny'
        : 'type "a" then Enter to approve, "d" to deny',
      "secondary",
    );
  }
  if (view.pendingQuestion !== null) {
    const question = view.pendingQuestion;
    append(`▌ question · ${question.question}`, "secondary", true);
    for (const option of question.options) append(`${option.id}) ${option.label}`, "dim");
    append(
      question.answerType === "confirmation"
        ? 'type "yes" or "no"'
        : question.answerType === "text"
          ? "type an answer"
          : question.multiple
            ? "type ids or labels, comma separated"
            : "type an option id or label",
      "faint",
    );
    if (view.answerError !== null) append(`not accepted: ${view.answerError}`, "tertiary");
  }
  return lines;
}

/** One-line title with the run state on the right, as the reference does. */
function TitleBar(props: { view: TuiViewState; capabilities: Capabilities }): ReactElement {
  const { view, capabilities } = props;
  const state = view.waitingKind === null ? view.runStatus : `waiting:${view.waitingKind}`;
  const stateColor =
    view.runStatus === "failed"
      ? colorFor("tertiary", capabilities)
      : view.waitingKind !== null
        ? colorFor("secondary", capabilities)
        : view.runStatus === "completed"
          ? colorFor("success", capabilities)
          : colorFor("dim", capabilities);
  return h(
    Box,
    { justifyContent: "space-between" },
    h(Text, { bold: true, ...colorProps(colorFor("primary", capabilities)) }, "lycwl"),
    h(Text, colorProps(stateColor), state),
  );
}

function marker(state: string): string {
  if (state === "completed") return "[x]";
  if (state === "in_progress") return "[>]";
  if (state === "cancelled") return "[-]";
  return "[ ]";
}

/**
 * The composer, with the lane bar on its left edge.
 *
 * The bar is the reference's most recognisable element: it marks where input goes and
 * carries the accent colour, so the input area is identifiable without a label.
 */
function Composer(props: {
  view: TuiViewState;
  editor: TextEdit;
  capabilities: Capabilities;
  width: number;
}): ReactElement {
  const { view, editor, capabilities } = props;
  const accent = colorFor(view.queueingInput ? "secondary" : "primary", capabilities);
  const hint =
    view.pendingApproval !== null
      ? view.pendingApprovalPreview === null
        ? "d deny · preview unavailable"
        : "a approve  ·  d deny"
      : view.pendingQuestion !== null
        ? "Enter answer"
        : view.queueingInput
          ? "queued as supplementary input for the running run"
          : view.canSubmit
            ? "Enter submits · /config settings · Ctrl+C cancels"
            : "run is busy";
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Box,
      null,
      h(Text, colorProps(accent), "▌ "),
      h(Text, colorProps(accent), view.queueingInput ? "queue" : "task"),
      h(Text, null, " › "),
      h(TextInput, {
        value: editor.value,
        cursor: editor.cursor,
        width: Math.max(1, props.width - (view.queueingInput ? 10 : 9)),
        color: accent,
      }),
    ),
    h(
      Box,
      { marginLeft: 2 },
      h(
        Text,
        colorProps(colorFor("faint", capabilities)),
        clipText(hint, Math.max(1, props.width - 2)),
      ),
    ),
  );
}

/**
 * Footer: mode on the left, model and status on the right.
 *
 * Clip the mode and model independently so they cannot collide on narrow terminals.
 */
function Footer(props: {
  view: TuiViewState;
  capabilities: Capabilities;
  modelLabel: string | undefined;
  modeLabel: string | undefined;
  width: number;
}): ReactElement {
  const { view, capabilities, modelLabel } = props;
  const mode = view.queueingInput ? "queue" : view.runStatus === "idle" ? "ready" : view.runStatus;
  const accent = colorFor(view.runStatus === "failed" ? "tertiary" : "primary", capabilities);
  return h(
    Box,
    { marginTop: 1, justifyContent: "space-between" },
    h(
      Text,
      { bold: true, ...colorProps(accent) },
      clipText(
        props.modeLabel === undefined ? mode : `${props.modeLabel} · ${mode}`,
        Math.max(1, Math.floor(props.width / 2)),
      ),
    ),
    h(
      Text,
      colorProps(colorFor("dim", capabilities)),
      clipText(
        modelLabel === undefined
          ? (view.safeCode ?? "")
          : `${modelLabel}${view.safeCode === null ? "" : ` · ${view.safeCode}`}`,
        Math.max(1, Math.floor(props.width / 2) - 1),
      ),
    ),
  );
}
