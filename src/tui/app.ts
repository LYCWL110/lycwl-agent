import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement, useState } from "react";

import type { TranscriptEntry, TuiViewState } from "./view-model.ts";

/**
 * Presentational TUI (V1_DESIGN_SUPPLEMENTS S02). Rendering is pure: it displays
 * a derived view and reports the user's intent through callbacks. It never
 * executes tools, decides permissions or resolves waits on its own.
 *
 * Written with createElement instead of JSX so the Node built-in TypeScript
 * runner can load it without a bundler.
 */
export type AppProps = Readonly<{
  view: TuiViewState;
  onSubmit: (text: string) => void;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (text: string) => void;
  onDeclineQuestion: () => void;
  onCancelRun: () => void;
  onQuit: () => void;
}>;

const h = createElement;

export function App(props: AppProps): ReactElement {
  const { view } = props;
  const [draft, setDraft] = useState("");

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
    h(Header, { view }),
    h(Transcript, { entries: view.transcript }),
    view.todo === null ? null : h(TodoPanel, { view }),
    h(ApprovalPanel, { view }),
    h(QuestionPanel, { view }),
    h(Composer, { view, draft }),
  );
}

function Header({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const waiting = view.waitingKind === null ? "" : ` - waiting:${view.waitingKind}`;
  const code = view.safeCode === null ? "" : ` - ${view.safeCode}`;
  return h(
    Box,
    null,
    h(Text, { bold: true }, "lycwl-agent"),
    h(Text, null, ` - run:${view.runStatus}${waiting}${code}`),
  );
}

function Transcript({ entries }: Readonly<{ entries: readonly TranscriptEntry[] }>): ReactElement {
  if (entries.length === 0) {
    return h(
      Box,
      { marginTop: 1 },
      h(Text, { dimColor: true }, "No activity yet. Type a task and press Enter."),
    );
  }
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    ...entries.map((entry) => h(TranscriptLine, { key: entry.id, entry })),
  );
}

function TranscriptLine({ entry }: Readonly<{ entry: TranscriptEntry }>): ReactElement {
  const label =
    entry.kind === "user"
      ? "you"
      : entry.kind === "assistant"
        ? "agent"
        : entry.kind === "tool"
          ? `tool${entry.status === null ? "" : `(${entry.status})`}`
          : "system";
  const color =
    entry.kind === "user"
      ? "cyan"
      : entry.kind === "assistant"
        ? "green"
        : entry.status === "failed" || entry.status === "denied"
          ? "red"
          : entry.kind === "system"
            ? "yellow"
            : undefined;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, color === undefined ? null : { color }, `[${label}]`),
    h(Box, { marginLeft: 2 }, h(Text, null, entry.text)),
  );
}

function TodoPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const list = view.todo;
  if (list === null) return h(Box, null);
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { bold: true }, `todo - revision ${list.revision}`),
    ...list.items.map((item) =>
      h(
        Box,
        { key: item.id, marginLeft: 2 },
        h(
          Text,
          item.state === "completed"
            ? { color: "green" }
            : item.state === "cancelled"
              ? { color: "red" }
              : item.state === "in_progress"
                ? { color: "yellow" }
                : null,
          `[${item.state}] ${item.content}`,
        ),
      ),
    ),
  );
}

function ApprovalPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const pending = view.pendingApproval;
  if (pending === null) return h(Box, null);
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { bold: true, color: "yellow" }, `Approval required: ${pending.toolName}`),
    h(Box, { marginLeft: 2 }, h(Text, { dimColor: true }, `approvalId=${pending.approvalId}`)),
    h(
      Box,
      { marginLeft: 2 },
      h(Text, null, 'type "a" then Enter to approve, "d" then Enter to deny'),
    ),
    h(
      Box,
      { marginLeft: 2 },
      h(Text, { dimColor: true }, "closing or ignoring this panel keeps the wait"),
    ),
  );
}

function QuestionPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const pending = view.pendingQuestion;
  if (pending === null) return h(Box, null);
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { bold: true, color: "yellow" }, `Question: ${pending.question}`),
    ...pending.options.map((option) =>
      h(Box, { key: option.id, marginLeft: 2 }, h(Text, null, `${option.id}) ${option.label}`)),
    ),
    h(
      Box,
      { marginLeft: 2 },
      h(Text, { dimColor: true }, "type an answer in the composer and press Enter"),
    ),
    h(
      Box,
      { marginLeft: 2 },
      h(Text, { dimColor: true }, "declining or cancelling the question is a separate action"),
    ),
  );
}

function Composer({ view, draft }: Readonly<{ view: TuiViewState; draft: string }>): ReactElement {
  const hint = view.queueingInput
    ? "queued as supplementary input for the running run"
    : view.canSubmit
      ? "Enter submits a new task"
      : "run is busy";
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Box,
      null,
      h(Text, { color: "cyan" }, view.queueingInput ? "queue> " : "task> "),
      h(Text, null, draft),
    ),
    h(Text, { dimColor: true }, hint),
    h(Text, { dimColor: true }, "ctrl+c cancels the run - esc quits"),
  );
}
