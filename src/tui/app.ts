import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement, useState } from "react";
import { type Capabilities, colorFor, detectCapabilities } from "./palette.ts";
import type { TranscriptEntry, TuiViewState } from "./view-model.ts";

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
}>;

export function App(props: AppProps): ReactElement {
  const { view } = props;
  const [draft, setDraft] = useState("");
  const capabilities =
    props.capabilities ??
    detectCapabilities({
      noColor: process.env["NO_COLOR"] !== undefined,
      colorterm: process.env["COLORTERM"],
      term: process.env["TERM"],
      force: process.env["LYCWL_COLOR"],
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
    if (key.return) {
      const text = draft.trim();
      setDraft("");
      if (text.length === 0) return;
      if (view.pendingQuestion !== null) props.onAnswer(text);
      else if (view.pendingApproval !== null) {
        if (text === "a") props.onApprove();
        else if (text === "d") props.onDeny();
      } else props.onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((current) => [...current].slice(0, -1).join(""));
      return;
    }
    if (input.length > 0) setDraft((current) => current + input);
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(TitleBar, { view, capabilities }),
    h(Transcript, { entries: view.transcript, capabilities }),
    view.todo === null ? null : h(TodoPanel, { view, capabilities }),
    h(ApprovalPanel, { view, capabilities }),
    h(QuestionPanel, { view, capabilities }),
    h(Composer, { view, draft, capabilities }),
    h(Footer, { view, capabilities, modelLabel: props.modelLabel }),
  );
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

function Transcript(props: {
  entries: readonly TranscriptEntry[];
  capabilities: Capabilities;
}): ReactElement {
  const { entries, capabilities } = props;
  if (entries.length === 0) {
    return h(
      Box,
      { marginTop: 1, marginLeft: 2 },
      h(Text, colorProps(colorFor("faint", capabilities)), "Type a task and press Enter."),
    );
  }
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    ...entries.map((entry) => h(TranscriptLine, { key: entry.id, entry, capabilities })),
  );
}

/**
 * A transcript row: a coloured gutter character, a role label, then the text.
 *
 * The gutter is what makes the role readable at a glance; the reference does the same
 * with its message prefixes.
 */
function TranscriptLine(props: {
  entry: TranscriptEntry;
  capabilities: Capabilities;
}): ReactElement {
  const { entry, capabilities } = props;
  const failed = entry.status === "failed" || entry.status === "denied";
  const role =
    entry.kind === "user"
      ? { text: "you", color: colorFor("primary", capabilities) }
      : entry.kind === "assistant"
        ? { text: "agent", color: colorFor("success", capabilities) }
        : entry.kind === "tool"
          ? {
              text: entry.status === null ? "tool" : `tool·${entry.status}`,
              color: failed
                ? colorFor("tertiary", capabilities)
                : colorFor("secondary", capabilities),
            }
          : { text: "sys", color: colorFor("faint", capabilities) };
  return h(
    Box,
    { flexDirection: "column", marginBottom: 0 },
    h(
      Box,
      null,
      h(Text, colorProps(role.color), "▌ "),
      h(Text, { bold: true, ...colorProps(role.color) }, role.text),
    ),
    h(Box, { marginLeft: 2 }, h(Text, null, entry.text)),
  );
}

function TodoPanel(props: { view: TuiViewState; capabilities: Capabilities }): ReactElement {
  const list = props.view.todo;
  if (list === null) return h(Box, null);
  return h(
    Box,
    { flexDirection: "column", marginTop: 1, marginLeft: 2 },
    h(Text, { bold: true, ...colorProps(colorFor("secondary", props.capabilities)) }, "plan"),
    ...list.items.map((item) =>
      h(
        Box,
        { key: item.id, marginLeft: 1 },
        h(
          Text,
          colorProps(
            item.state === "completed"
              ? colorFor("success", props.capabilities)
              : item.state === "cancelled"
                ? colorFor("tertiary", props.capabilities)
                : item.state === "in_progress"
                  ? colorFor("secondary", props.capabilities)
                  : colorFor("dim", props.capabilities),
          ),
          `${marker(item.state)} ${item.content}`,
        ),
      ),
    ),
  );
}

function marker(state: string): string {
  if (state === "completed") return "[x]";
  if (state === "in_progress") return "[>]";
  if (state === "cancelled") return "[-]";
  return "[ ]";
}

function ApprovalPanel(props: { view: TuiViewState; capabilities: Capabilities }): ReactElement {
  const pending = props.view.pendingApproval;
  if (pending === null) return h(Box, null);
  const preview = props.view.pendingApprovalPreview;
  const accent = colorFor("secondary", props.capabilities);
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Box,
      null,
      h(Text, colorProps(accent), "▌ "),
      h(Text, { bold: true, ...colorProps(accent) }, `approval required · ${pending.toolName}`),
    ),
    ...(preview === null
      ? [
          h(
            Box,
            { key: "none", marginLeft: 2 },
            h(
              Text,
              colorProps(colorFor("tertiary", props.capabilities)),
              "preview unavailable: the exact operation is not recorded",
            ),
          ),
        ]
      : preview.map((line, index) =>
          h(
            Box,
            { key: `p${index}`, marginLeft: 2 },
            h(Text, null, line.length === 0 ? " " : line),
          ),
        )),
    h(
      Box,
      { marginLeft: 2 },
      h(
        Text,
        colorProps(colorFor("faint", props.capabilities)),
        'type "a" then Enter to approve, "d" to deny',
      ),
    ),
  );
}

function QuestionPanel(props: { view: TuiViewState; capabilities: Capabilities }): ReactElement {
  const pending = props.view.pendingQuestion;
  if (pending === null) return h(Box, null);
  const accent = colorFor("secondary", props.capabilities);
  const hint =
    pending.answerType === "confirmation"
      ? 'type "yes" or "no"'
      : pending.answerType === "text"
        ? "type an answer"
        : pending.multiple
          ? "type ids or labels, comma separated"
          : "type an option id or label";
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Box,
      null,
      h(Text, colorProps(accent), "▌ "),
      h(Text, { bold: true, ...colorProps(accent) }, `question · ${pending.question}`),
    ),
    ...pending.options.map((option) =>
      h(
        Box,
        { key: option.id, marginLeft: 2 },
        h(Text, colorProps(colorFor("primary", props.capabilities)), option.id),
        h(Text, null, `) ${option.label}`),
      ),
    ),
    h(Box, { marginLeft: 2 }, h(Text, colorProps(colorFor("faint", props.capabilities)), hint)),
    props.view.answerError === null
      ? null
      : h(
          Box,
          { marginLeft: 2 },
          h(
            Text,
            colorProps(colorFor("tertiary", props.capabilities)),
            `not accepted: ${props.view.answerError}`,
          ),
        ),
  );
}

/**
 * The composer, with the lane bar on its left edge.
 *
 * The bar is the reference's most recognisable element: it marks where input goes and
 * carries the accent colour, so the input area is identifiable without a label.
 */
function Composer(props: {
  view: TuiViewState;
  draft: string;
  capabilities: Capabilities;
}): ReactElement {
  const { view, draft, capabilities } = props;
  const accent = colorFor(view.queueingInput ? "secondary" : "primary", capabilities);
  const hint = view.queueingInput
    ? "queued as supplementary input for the running run"
    : view.canSubmit
      ? "Enter submits · Esc quits · Ctrl+C cancels the run"
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
      h(Text, null, draft),
      h(Text, colorProps(accent), "_"),
    ),
    h(Box, { marginLeft: 2 }, h(Text, colorProps(colorFor("faint", capabilities)), hint)),
  );
}

/**
 * Footer: mode on the left, model and status on the right.
 *
 * The reference keeps this to one line and drops the least important segment first
 * when space is short. Here the segments are few enough that dropping is unnecessary.
 */
function Footer(props: {
  view: TuiViewState;
  capabilities: Capabilities;
  modelLabel: string | undefined;
}): ReactElement {
  const { view, capabilities, modelLabel } = props;
  const mode = view.queueingInput ? "queue" : view.runStatus === "idle" ? "ready" : view.runStatus;
  const accent = colorFor(view.runStatus === "failed" ? "tertiary" : "primary", capabilities);
  return h(
    Box,
    { marginTop: 1, justifyContent: "space-between" },
    h(Text, { bold: true, ...colorProps(accent) }, mode),
    h(
      Text,
      colorProps(colorFor("dim", capabilities)),
      modelLabel === undefined
        ? (view.safeCode ?? "")
        : `${modelLabel}${view.safeCode === null ? "" : ` · ${view.safeCode}`}`,
    ),
  );
}

/** Ink rejects an explicit `undefined` colour, so the prop is built conditionally. */
function colorProps(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}
