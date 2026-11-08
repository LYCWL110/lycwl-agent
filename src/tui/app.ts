import { Box, Text, useInput, usePaste } from "ink";
import { createElement, type ReactElement, useState } from "react";
import { ActivityIndicator } from "./activity-indicator.ts";
import { Brand, clipText, colorProps, useViewport, type Viewport, wrapText } from "./chrome.ts";
import { CommandMenu } from "./command-menu.ts";
import { CredentialScreen } from "./credential-screen.ts";
import { LocalPanel } from "./local-panel.ts";
import { McpPanel } from "./mcp-panel.ts";
import { type Capabilities, colorFor, detectCapabilities } from "./palette.ts";
import { useTerminalWheel } from "./terminal-wheel.ts";
import { characters, editText, type TextEdit } from "./text-edit.ts";
import { TextInput } from "./text-input.ts";
import { COMPOSER_COMMANDS, commandEnabled, type TuiViewState } from "./view-model.ts";

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
 * Provider activity comes from recorded Runtime events, not inferred reasoning.
 */

const h = createElement;

export type AppProps = Readonly<{
  view: TuiViewState;
  // biome-ignore lint/suspicious/noConfusingVoidType: Existing submit callbacks may acknowledge without a return value.
  onSubmit: (text: string) => void | boolean | Promise<undefined | boolean>;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (text: string) => void;
  onDeclineQuestion: () => void;
  onCancelRun: () => void;
  onQuit: () => void;
  onClosePanel?: () => void;
  onCorrectCredential?: (secret: string) => Promise<boolean>;
  /** MCP declaration edits; the caller owns the config store write. */
  onMcpAdd?: (
    entry: Readonly<{ serverId: string; command: string; args: readonly string[] }>,
  ) => void;
  onMcpRemove?: (serverId: string) => void;
  sessionId?: string;
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
  const [scroll, setScroll] = useState<number | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommands, setDismissedCommands] = useState(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const viewport = useViewport(props.viewport);
  const width = Math.max(1, viewport.columns - 4);
  const lobby = view.runStatus === "idle" && view.transcript.length === 0 && view.todo === null;
  const lobbyWidth = Math.max(1, Math.min(84, Math.max(50, Math.floor((width * 2) / 3)), width));
  const commands =
    !dismissedCommands &&
    view.pendingApproval === null &&
    view.pendingDisclosure == null &&
    view.pendingQuestion === null &&
    draft.startsWith("/")
      ? COMPOSER_COMMANDS.filter((command) => command.name.startsWith(draft))
      : [];
  const selectedCommand = Math.min(commandIndex, Math.max(0, commands.length - 1));
  const bodyRows = Math.max(1, viewport.rows - 9);
  const lines = documentLines(view, width, expandedTools, selectedTool);
  const maxStart = Math.max(0, lines.length - bodyRows);
  const start = scroll === null ? maxStart : Math.min(scroll, maxStart);
  const capabilities =
    props.capabilities ??
    detectCapabilities({
      noColor: process.env["NO_COLOR"] !== undefined,
      colorterm: process.env["COLORTERM"],
      term: process.env["TERM"],
      force: process.env["LYCWL_COLOR"],
      windowsTerminal: process.env["WT_SESSION"] !== undefined,
    });

  function scrollBy(delta: number): void {
    setScroll((current) => {
      const top = current === null ? maxStart : Math.min(current, maxStart);
      const next = Math.max(0, Math.min(maxStart, top + delta));
      return next === maxStart ? null : next;
    });
  }

  function toggleTool(id: string): void {
    setSelectedTool(id);
    setScroll(start);
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit(text: string): void {
    setEditor({ value: "", cursor: 0 });
    setScroll(null);
    void Promise.resolve(props.onSubmit(text)).then((accepted) => {
      if (accepted === false)
        setEditor((current) =>
          current.value === "" ? { value: text, cursor: characters(text).length } : current,
        );
    });
  }

  useInput((input, key) => {
    if (view.localPanel != null) return;
    if (key.ctrl && input === "c") {
      props.onCancelRun();
      return;
    }
    if (key.ctrl && input === "t") {
      const visibleTools = lines
        .slice(start, start + bodyRows)
        .filter((line) => line.toolId !== undefined);
      const id =
        selectedTool !== null &&
        view.transcript.some((entry) => entry.id === selectedTool && entry.tool !== undefined)
          ? selectedTool
          : visibleTools.at(-1)?.toolId;
      if (id !== undefined && id !== null) toggleTool(id);
      return;
    }
    if (key.escape) {
      if (commands.length > 0) {
        setDismissedCommands(true);
        return;
      }
      props.onQuit();
      return;
    }
    if (key.pageUp) {
      scrollBy(-Math.max(1, bodyRows - 1));
      return;
    }
    if (key.pageDown) {
      scrollBy(Math.max(1, bodyRows - 1));
      return;
    }
    if (key.ctrl && key.home) {
      setScroll(0);
      return;
    }
    if (key.ctrl && key.end) {
      setScroll(null);
      return;
    }
    if (commands.length > 0) {
      if (key.upArrow || key.downArrow) {
        setCommandIndex(
          (selectedCommand + (key.upArrow ? -1 : 1) + commands.length) % commands.length,
        );
        return;
      }
      const command = commands[selectedCommand];
      if (key.tab && command !== undefined) {
        setEditor({ value: command.name, cursor: command.name.length });
        return;
      }
      if (key.return && command !== undefined && !commandEnabled(view, command)) return;
      if (key.return && command !== undefined) {
        submit(command.name);
        return;
      }
    }
    if (key.return) {
      const text = draft.trim();
      setEditor({ value: "", cursor: 0 });
      setScroll(null);
      if (text.length === 0) return;
      if (view.pendingQuestion !== null) props.onAnswer(text);
      else if (view.pendingDisclosure != null) {
        if (text === "a") props.onApprove();
        else if (text === "d") props.onDeny();
      } else if (view.pendingApproval !== null) {
        if (text === "a" && view.pendingApprovalPreview !== null) props.onApprove();
        else if (text === "d") props.onDeny();
      } else submit(text);
      return;
    }
    setCommandIndex(0);
    setDismissedCommands(false);
    setEditor((current) => editText(current, input, key));
  });

  usePaste((text) => {
    if (view.localPanel != null) return;
    setCommandIndex(0);
    setDismissedCommands(false);
    setEditor((current) => editText(current, text, {}));
  });

  useTerminalWheel(
    (event) => {
      if (view.localPanel != null) return;
      if (
        !lobby &&
        event.row >= 3 &&
        event.row < 3 + bodyRows &&
        event.column <= viewport.columns
      ) {
        scrollBy(event.direction === "up" ? -3 : 3);
      }
    },
    (event) => {
      if (view.localPanel != null || lobby || event.column < 3 || event.column > width + 2) return;
      const offset = event.row - 3;
      if (offset < 0 || offset >= bodyRows) return;
      const id = lines[start + offset]?.toolId;
      if (id !== undefined) toggleTool(id);
    },
  );

  if (view.localPanel === "credential")
    return h(CredentialScreen, {
      width,
      onSave: props.onCorrectCredential ?? (async () => false),
      onClose: () => props.onClosePanel?.(),
    });
  if (view.localPanel === "mcp")
    return h(McpPanel, {
      viewport,
      capabilities,
      servers: view.mcpServers ?? null,
      error: view.mcpError ?? null,
      busy: view.mcpBusy === true,
      notice: view.commandNotice ?? null,
      onAdd: (entry) => props.onMcpAdd?.(entry),
      onRemove: (serverId) => props.onMcpRemove?.(serverId),
      onClose: () => props.onClosePanel?.(),
    });
  if (view.localPanel != null)
    return h(LocalPanel, {
      key: view.localPanel,
      kind: view.localPanel,
      sessionId: props.sessionId,
      ...(view.skillCatalog === undefined ? {} : { skillCatalog: view.skillCatalog }),
      ...(view.skillCatalogError === undefined
        ? {}
        : { skillCatalogError: view.skillCatalogError }),
      notice: view.commandNotice,
      viewport,
      capabilities,
      onSubmit: props.onSubmit,
      onClose: () => props.onClosePanel?.(),
    });

  if (lobby) {
    return h(
      Box,
      {
        width: viewport.columns,
        height: Math.max(1, viewport.rows - 1),
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
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
        h(Composer, {
          view,
          editor,
          capabilities,
          width: lobbyWidth,
          commands,
          selectedCommand,
          commandRows: Math.max(1, Math.min(6, Math.floor((viewport.rows - 5) / 2))),
          animated: props.animated,
        }),
        h(Footer, {
          view,
          capabilities,
          modelLabel: props.modelLabel,
          modeLabel: props.modeLabel,
          width: lobbyWidth,
        }),
      ),
      viewport.rows < 16
        ? null
        : h(
            Box,
            { marginTop: 1 },
            h(Text, colorProps(colorFor("dim", capabilities)), "lycwl  ·  0.1.0"),
          ),
    );
  }
  return h(
    Box,
    {
      flexDirection: "column",
      width: viewport.columns,
      height: Math.max(1, viewport.rows - 1),
      paddingX: 2,
      overflow: "hidden",
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
        ? clipText(
            `${start + 1}–${Math.min(start + bodyRows, lines.length)} / ${lines.length}  ·  Scroll / PgUp / PgDn`,
            width,
          )
        : "─".repeat(width),
    ),
    h(Composer, {
      view,
      editor,
      capabilities,
      width,
      commands,
      selectedCommand,
      commandRows: Math.max(1, Math.min(6, viewport.rows - 6)),
      animated: props.animated,
    }),
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
  toolId?: string;
}>;

/** Wrap rather than truncate: approval commands and diffs remain available by paging. */
function documentLines(
  view: TuiViewState,
  width: number,
  expanded: ReadonlySet<string>,
  selected: string | null,
): DocumentLine[] {
  const lines: DocumentLine[] = [];
  function append(text: string, role: DocumentLine["role"], bold = false): void {
    lines.push(...wrapText(displayText(text), width).map((line) => ({ text: line, role, bold })));
  }
  for (const entry of view.transcript) {
    if (entry.kind === "tool" && entry.tool !== undefined) {
      const isExpanded = expanded.has(entry.id);
      const role =
        entry.status === "failed" || entry.status === "denied" || entry.status === "outcome_unknown"
          ? "tertiary"
          : entry.status === "succeeded"
            ? "success"
            : "secondary";
      const prefix = `${selected === entry.id ? "▸" : " "} ${isExpanded ? "▾" : "▸"} `;
      const suffix = ` · ${entry.status ?? "requested"}`;
      lines.push({
        text: clipText(
          `${prefix}${clipText(displayText(entry.tool.summary), Math.max(1, width - prefix.length - suffix.length))}${suffix}`,
          width,
        ),
        role,
        bold: true,
        toolId: entry.id,
      });
      if (isExpanded) {
        append(entry.tool.details || "(no recorded details)", "dim");
      }
      append("", "faint");
      continue;
    }
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
        ? `you${entry.status === null ? "" : ` · ${entry.status}`}`
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
  if (view.pendingDisclosure != null) {
    append("Sensitive context redisclosure", "secondary", true);
    for (const line of view.pendingDisclosure.safePreview.split("\n")) append(line, "dim");
    append('type "a" then Enter to consent, "d" to deny', "secondary");
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

function displayText(text: string): string {
  return text.replace(/[\p{Control}\p{Bidi_Control}]/gu, (character) =>
    character === "\n" || character === "\r"
      ? character
      : character === "\t"
        ? "    "
        : `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
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
  commands: (typeof COMPOSER_COMMANDS)[number][];
  selectedCommand: number;
  commandRows: number;
  animated?: boolean | undefined;
}): ReactElement {
  const { view, editor, capabilities } = props;
  const accent = colorFor(view.queueingInput ? "secondary" : "primary", capabilities);
  const hint =
    view.pendingDisclosure != null
      ? "a consent  /  d deny"
      : view.pendingApproval !== null
        ? view.pendingApprovalPreview === null
          ? "d deny · preview unavailable"
          : "a approve  ·  d deny"
        : view.pendingQuestion !== null
          ? "Enter answer"
          : view.queueingInput
            ? "queued as supplementary input for the running run"
            : view.canSubmit
              ? "Enter submits · / commands · Ctrl+C cancels"
              : "run is busy";
  return h(
    Box,
    { flexDirection: "column", marginTop: 1, flexShrink: 0 },
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
      view.activity === null
        ? h(
            Text,
            colorProps(colorFor("faint", capabilities)),
            clipText(view.commandNotice ?? hint, Math.max(1, props.width - 2)),
          )
        : h(ActivityIndicator, {
            activity: view.activity,
            capabilities,
            width: Math.max(1, props.width - 2),
            animated: props.animated,
          }),
    ),
    h(CommandMenu, {
      commands: props.commands,
      selected: props.selectedCommand,
      enabled: view.canSubmit,
      width: props.width,
      capabilities,
      rows: props.commandRows,
    }),
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
