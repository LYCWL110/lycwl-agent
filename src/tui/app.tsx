import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useState } from "react";

import type { TranscriptEntry, TuiViewState } from "./view-model.ts";

/**
 * Presentational TUI (V1_DESIGN_SUPPLEMENTS S02). Rendering is pure: it displays
 * a derived view and reports the user's intent through callbacks. It never
 * executes tools, decides permissions or resolves waits on its own.
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

  return (
    <Box flexDirection="column">
      <Header view={view} />
      <Transcript entries={view.transcript} />
      {view.todo === null ? null : <TodoPanel view={view} />}
      <ApprovalPanel view={view} />
      <QuestionPanel view={view} />
      <Composer view={view} draft={draft} />
    </Box>
  );
}

function Header({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const waiting = view.waitingKind === null ? "" : ` - waiting:${view.waitingKind}`;
  const code = view.safeCode === null ? "" : ` - ${view.safeCode}`;
  return (
    <Box>
      <Text bold>lycwl-agent</Text>
      <Text>{` - run:${view.runStatus}${waiting}${code}`}</Text>
    </Box>
  );
}

function Transcript({ entries }: Readonly<{ entries: readonly TranscriptEntry[] }>): ReactElement {
  if (entries.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No activity yet. Type a task and press Enter.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {entries.map((entry) => (
        <TranscriptLine key={entry.id} entry={entry} />
      ))}
    </Box>
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
  return (
    <Box flexDirection="column">
      <Text {...(color === undefined ? {} : { color })}>{`[${label}]`}</Text>
      <Box marginLeft={2}>
        <Text>{entry.text}</Text>
      </Box>
    </Box>
  );
}

function TodoPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const list = view.todo;
  if (list === null) return <Box />;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`todo - revision ${list.revision}`}</Text>
      {list.items.map((item) => (
        <Box key={item.id} marginLeft={2}>
          <Text
            {...(item.state === "completed"
              ? { color: "green" as const }
              : item.state === "cancelled"
                ? { color: "red" as const }
                : item.state === "in_progress"
                  ? { color: "yellow" as const }
                  : {})}
          >
            {`[${item.state}] ${item.content}`}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function ApprovalPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const pending = view.pendingApproval;
  if (pending === null) return <Box />;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">{`Approval required: ${pending.toolName}`}</Text>
      <Box marginLeft={2}>
        <Text dimColor>{`approvalId=${pending.approvalId}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>type "a" then Enter to approve, "d" then Enter to deny</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>closing or ignoring this panel keeps the wait</Text>
      </Box>
    </Box>
  );
}

function QuestionPanel({ view }: Readonly<{ view: TuiViewState }>): ReactElement {
  const pending = view.pendingQuestion;
  if (pending === null) return <Box />;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">{`Question: ${pending.question}`}</Text>
      {pending.options.map((option) => (
        <Box key={option.id} marginLeft={2}>
          <Text>{`${option.id}) ${option.label}`}</Text>
        </Box>
      ))}
      <Box marginLeft={2}>
        <Text dimColor>type an answer in the composer and press Enter</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>declining or cancelling the question is a separate action</Text>
      </Box>
    </Box>
  );
}

function Composer({ view, draft }: Readonly<{ view: TuiViewState; draft: string }>): ReactElement {
  const hint = view.queueingInput
    ? "queued as supplementary input for the running run"
    : view.canSubmit
      ? "Enter submits a new task"
      : "run is busy";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan">{view.queueingInput ? "queue> " : "task> "}</Text>
        <Text>{draft}</Text>
      </Box>
      <Text dimColor>{hint}</Text>
      <Text dimColor>ctrl+c cancels the run - esc quits</Text>
    </Box>
  );
}
