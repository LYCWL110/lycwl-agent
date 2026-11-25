import { Box, Text, useInput, usePaste } from "ink";
import { createElement, type ReactElement, useState } from "react";
import type { ProviderImage } from "../ports/model-provider.ts";
import { ActivityIndicator } from "./activity-indicator.ts";
import {
  Brand,
  cellWidth,
  clipText,
  colorProps,
  useViewport,
  type Viewport,
  wrapText,
} from "./chrome.ts";
import { CommandMenu } from "./command-menu.ts";
import { CredentialScreen } from "./credential-screen.ts";
import { InitPanel } from "./init-panel.ts";
import { LocalPanel } from "./local-panel.ts";
import { McpPanel } from "./mcp-panel.ts";
import { type Capabilities, colorFor, detectCapabilities } from "./palette.ts";
import { SessionList } from "./session-list.ts";
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

type ApprovalChoice = "approve" | "deny";

export type AppProps = Readonly<{
  view: TuiViewState;
  // biome-ignore lint/suspicious/noConfusingVoidType: Existing submit callbacks may acknowledge without a return value.
  onSubmit: (
    text: string,
    images?: readonly ProviderImage[],
  ) => void | boolean | Promise<undefined | boolean>;
  /**
   * Read an image from the system clipboard.
   *
   * Absent means Ctrl+V only pastes text, which is what a platform without a
   * clipboard reader gets.
   */
  onPasteImage?: () => Promise<
    | Readonly<{ kind: "image"; image: ProviderImage }>
    | Readonly<{ kind: "empty" }>
    | Readonly<{ kind: "too_large" }>
    | Readonly<{ kind: "unavailable" }>
  >;
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
  /** AGENTS.md draft confirmation. */
  onInitConfirm?: () => void;
  initBusy?: boolean;
  /** Session list actions; the caller owns the disk operations. */
  onSessionResume?: (sessionId: string) => void;
  onSessionRename?: (sessionId: string, title: string | null) => void;
  onSessionDelete?: (sessionId: string) => void;
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
  /**
   * Focused approval button. Focus is not a reply: the Run stays suspended
   * until Enter confirms the selected action. A new approval starts on Approve
   * for tool calls and on Cancel for sensitive redisclosure.
   */
  const approvalKey =
    view.pendingApproval?.approvalId ?? view.pendingDisclosure?.disclosureId ?? null;
  const approvalDefault: ApprovalChoice = view.pendingDisclosure === null ? "approve" : "deny";
  const [approvalSelection, setApprovalSelection] = useState<{
    key: string;
    choice: ApprovalChoice;
  } | null>(null);
  const canApprove = view.pendingDisclosure !== null || view.pendingApprovalPreview !== null;
  const selectedApproval: ApprovalChoice =
    approvalKey !== null && approvalSelection?.key === approvalKey
      ? approvalSelection.choice
      : approvalDefault;
  const approvalChoice: ApprovalChoice = canApprove ? selectedApproval : "deny";
  /**
   * Images pasted with Ctrl+V and not yet sent.
   *
   * A terminal paste carries text only, so the image is read from the system
   * clipboard when the user presses the key. It is held here until the next submit
   * and then cleared, which matches how a text draft behaves.
   */
  const [pastedImages, setPastedImages] = useState<readonly ProviderImage[]>([]);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
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
  // The approval box is taller than the ordinary composer; reserve its lines so
  // the title bar and the decision controls stay on screen together.
  const bodyRows = Math.max(1, viewport.rows - (approvalKey === null ? 9 : 14));
  const lines = documentLines(view, width, expandedTools);
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

  function selectApproval(choice: ApprovalChoice): void {
    if (approvalKey === null) return;
    setApprovalSelection({ key: approvalKey, choice });
  }

  function scrollBy(delta: number): void {
    setScroll((current) => {
      const top = current === null ? maxStart : Math.min(current, maxStart);
      const next = Math.max(0, Math.min(maxStart, top + delta));
      return next === maxStart ? null : next;
    });
  }

  function toggleTool(id: string, reveal = false): void {
    setSelectedTool(id);
    if (reveal && !expandedTools.has(id)) {
      const index = lines.findIndex((line) => line.toolId === id);
      setScroll(index < 0 ? start : index);
    } else {
      setScroll(start);
    }
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit(text: string): void {
    const images = pastedImages;
    setEditor({ value: "", cursor: 0 });
    setPastedImages([]);
    setImageNotice(null);
    setScroll(null);
    void Promise.resolve(props.onSubmit(text, images.length === 0 ? undefined : images)).then(
      (accepted) => {
        if (accepted === false)
          setEditor((current) =>
            current.value === "" ? { value: text, cursor: characters(text).length } : current,
          );
      },
    );
  }

  useInput((input, key) => {
    if (view.localPanel != null) return;
    if (key.ctrl && input === "c") {
      props.onCancelRun();
      return;
    }
    if (approvalKey !== null) {
      // The composer is an approval box while a decision is pending, so every
      // letter is a decision shortcut rather than text. Scrolling keys still
      // reach the preview; everything else is swallowed.
      if (key.leftArrow) {
        selectApproval(canApprove ? "approve" : "deny");
        return;
      }
      if (key.rightArrow) {
        selectApproval("deny");
        return;
      }
      if (input === "a") {
        if (canApprove) selectApproval("approve");
        return;
      }
      if (input === "d") {
        selectApproval("deny");
        return;
      }
      if (key.return) {
        if (approvalChoice === "approve" && canApprove) props.onApprove();
        else props.onDeny();
        return;
      }
      if (!(key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end)))) return;
    }
    if (key.ctrl && input === "v") {
      // A terminal delivers the key, not the image. Reading the clipboard here is
      // the only way to see a pasted picture.
      const read = props.onPasteImage;
      if (read === undefined) return;
      void read().then((result) => {
        if (result.kind === "image") {
          setPastedImages((current) => [...current, result.image]);
          setImageNotice(null);
          return;
        }
        if (result.kind === "too_large") {
          setImageNotice("pasted image is too large");
          return;
        }
        if (result.kind === "unavailable") {
          setImageNotice("could not read the clipboard");
        }
        // "empty" means the clipboard held text; the terminal's own paste already
        // handled it, so nothing is reported.
      });
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
      if (id !== undefined && id !== null) toggleTool(id, true);
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
      else submit(text);
      return;
    }
    setCommandIndex(0);
    setDismissedCommands(false);
    setEditor((current) => editText(current, input, key));
  });

  usePaste((text) => {
    if (view.localPanel != null || approvalKey !== null) return;
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
  if (view.localPanel === "init" && view.initPreview != null)
    return h(InitPanel, {
      viewport,
      capabilities,
      preview: view.initPreview,
      busy: props.initBusy === true,
      notice: view.commandNotice ?? null,
      onConfirm: () => props.onInitConfirm?.(),
      onCancel: () => props.onClosePanel?.(),
    });
  if (view.localPanel === "sessions")
    return h(SessionList, {
      viewport,
      capabilities,
      sessions: view.sessionList ?? null,
      error: view.sessionListError ?? null,
      busy: view.sessionListBusy === true,
      notice: view.commandNotice ?? null,
      onResume: (sessionId) => props.onSessionResume?.(sessionId),
      onRename: (sessionId, title) => props.onSessionRename?.(sessionId, title),
      onDelete: (sessionId) => props.onSessionDelete?.(sessionId),
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
  // "init" is rendered above by its own panel; the rest fall through to LocalPanel.
  if (view.localPanel != null && view.localPanel !== "init")
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
          attachedImages: pastedImages.length,
          imageNotice,
          approvalChoice,
          canApprove,
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
            ...(line.background === true && capabilities.depth !== "mono"
              ? { backgroundColor: "black" }
              : {}),
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
      attachedImages: pastedImages.length,
      imageNotice,
      approvalChoice,
      canApprove,
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
  /** Fill the terminal background to make a tool box read as one block. */
  background?: boolean;
}>;

/** Wrap rather than truncate: approval commands and diffs remain available by paging. */
function documentLines(
  view: TuiViewState,
  width: number,
  expanded: ReadonlySet<string>,
): DocumentLine[] {
  const lines: DocumentLine[] = [];
  function append(text: string, role: DocumentLine["role"], bold = false): void {
    lines.push(...wrapText(displayText(text), width).map((line) => ({ text: line, role, bold })));
  }
  function appendBoxTop(text: string, role: DocumentLine["role"], toolId: string): void {
    if (width < 8) {
      append(text, role, true);
      return;
    }
    const left = "┌─ ";
    const right = " ┐";
    const inner = Math.max(1, width - cellWidth(left) - cellWidth(right));
    const clipped = clipText(displayText(text), Math.max(1, inner - 1));
    const fill = "─".repeat(Math.max(0, inner - cellWidth(clipped) - 1));
    lines.push({
      text: clipText(`${left}${clipped} ${fill}${right}`, width),
      role,
      bold: true,
      toolId,
    });
  }
  function appendBoxBottom(toolId: string): void {
    if (width < 8) return;
    lines.push({
      text: `└${"─".repeat(Math.max(0, width - 2))}┘`,
      role: "faint",
      toolId,
    });
  }
  function appendBoxLine(
    text: string,
    role: DocumentLine["role"],
    toolId: string,
    background = true,
  ): void {
    if (width < 8) {
      append(text, role);
      return;
    }
    const inner = Math.max(1, width - 4);
    const clipped = clipText(displayText(text), inner);
    const padding = " ".repeat(Math.max(0, inner - cellWidth(clipped)));
    lines.push({
      text: `│ ${clipped}${padding} │`,
      role,
      toolId,
      ...(background ? { background: true } : {}),
    });
  }
  function appendToolBlock(entry: TuiViewState["transcript"][number], isExpanded: boolean): void {
    if (entry.tool === undefined) {
      const role = entry.status === "failed" || entry.status === "denied" ? "tertiary" : "dim";
      append(`▌ tool·${entry.status ?? "requested"}`, role, true);
      append(entry.text, "dim");
      return;
    }
    const status = entry.status ?? "requested";
    const role =
      status === "failed" || status === "denied" || status === "outcome_unknown"
        ? "tertiary"
        : status === "succeeded"
          ? "success"
          : "secondary";
    appendBoxTop(`${isExpanded ? "▾" : "▸"} ${entry.tool.summary} · ${status}`, role, entry.id);
    const detailLines =
      entry.tool.details.length === 0 ? ["(no recorded details)"] : entry.tool.details.split("\n");
    const shown = isExpanded ? detailLines : detailLines.slice(0, 2);
    const hidden = detailLines.length - shown.length;
    if (!isExpanded && hidden > 0) {
      appendBoxLine(`… ${hidden} more line(s) · click to expand`, "faint", entry.id);
    }
    for (const detail of shown) {
      for (const wrapped of wrapText(displayText(detail), Math.max(1, width - 4))) {
        appendBoxLine(wrapped, "dim", entry.id);
      }
    }
    appendBoxBottom(entry.id);
  }
  for (const entry of view.transcript) {
    if (entry.kind === "tool") {
      appendToolBlock(entry, expanded.has(entry.id));
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
          ? `agent${entry.status === "streaming" ? " · streaming" : ""}`
          : "[sys]";
    append(`▌ ${label}`, entry.kind === "system" ? "secondary" : role, true);
    append(entry.status === "streaming" ? `${entry.text}▍` : entry.text, "dim");
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
    append("decision: use the consent box below", "faint");
  }
  if (view.pendingApproval !== null) {
    append(`▌ approval required · ${view.pendingApproval.toolName}`, "secondary", true);
    if (view.pendingApprovalPreview === null)
      append("preview unavailable: the exact operation is not recorded", "tertiary");
    else for (const line of view.pendingApprovalPreview) append(line, "dim");
    append("decision: use the approval box below", "faint");
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
 * The approval box that replaces the composer while a decision is pending.
 *
 * The full operation preview stays in the transcript, where it is scrollable.
 * This box owns the decision, so ordinary input cannot be typed or queued until
 * Approve or Cancel is confirmed.
 */
function ApprovalBox(props: {
  view: TuiViewState;
  capabilities: Capabilities;
  width: number;
  choice: ApprovalChoice;
  canApprove: boolean;
}): ReactElement {
  const { view, capabilities, choice, canApprove } = props;
  const disclosure = view.pendingDisclosure !== null;
  const title = disclosure
    ? "sensitive context redisclosure"
    : `approval required · ${view.pendingApproval?.toolName ?? "tool"}`;
  const approveLabel = disclosure ? "Consent" : "Approve";
  const approveText = canApprove
    ? `${choice === "approve" ? "▶ " : "  "}${approveLabel}`
    : `  ${approveLabel} (unavailable)`;
  const cancelText = `${choice === "deny" ? "▶ " : "  "}Cancel`;
  return h(
    Box,
    {
      flexDirection: "column",
      marginTop: 1,
      flexShrink: 0,
      width: props.width,
      borderStyle: "round",
      borderColor: colorFor("secondary", capabilities),
      paddingX: 1,
    },
    h(Text, { bold: true, ...colorProps(colorFor("secondary", capabilities)) }, `▌ ${title}`),
    h(
      Box,
      { marginTop: 1 },
      h(
        Text,
        {
          ...colorProps(
            colorFor(choice === "approve" && canApprove ? "secondary" : "dim", capabilities),
          ),
          ...(choice === "approve" && canApprove ? { bold: true } : {}),
        },
        approveText,
      ),
      h(Text, null, "    "),
      h(
        Text,
        {
          ...colorProps(colorFor(choice === "deny" ? "secondary" : "dim", capabilities)),
          ...(choice === "deny" ? { bold: true } : {}),
        },
        cancelText,
      ),
    ),
    h(
      Text,
      colorProps(colorFor("faint", capabilities)),
      "←/→ select · Enter confirms · input returns after the decision",
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
  editor: TextEdit;
  capabilities: Capabilities;
  width: number;
  commands: (typeof COMPOSER_COMMANDS)[number][];
  selectedCommand: number;
  commandRows: number;
  /** Images attached to the draft but not yet sent. */
  attachedImages: number;
  /** Why the last paste produced no image. */
  imageNotice: string | null;
  approvalChoice: ApprovalChoice;
  canApprove: boolean;
  animated?: boolean | undefined;
}): ReactElement {
  const { view, editor, capabilities } = props;
  if (view.pendingDisclosure != null || view.pendingApproval !== null) {
    return h(ApprovalBox, {
      view,
      capabilities,
      width: props.width,
      choice: props.approvalChoice,
      canApprove: props.canApprove,
    });
  }
  const accent = colorFor(view.queueingInput ? "secondary" : "primary", capabilities);
  const hint =
    view.pendingQuestion !== null
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
      // The attachment marker sits before the input so the user sees that the next
      // send will carry an image before typing the task.
      props.attachedImages === 0
        ? null
        : h(
            Text,
            colorProps(colorFor("secondary", capabilities)),
            `[image ×${props.attachedImages}] `,
          ),
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
            clipText(props.imageNotice ?? view.commandNotice ?? hint, Math.max(1, props.width - 2)),
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
 * Footer: mode on the left, model, tokens and status on the right.
 *
 * Clip each segment independently so they cannot collide on narrow terminals.
 */
function Footer(props: {
  view: TuiViewState;
  capabilities: Capabilities;
  modelLabel: string | undefined;
  modeLabel: string | undefined;
  width: number;
}): ReactElement {
  const { view, capabilities, modelLabel } = props;
  const approvalPending = view.pendingApproval !== null || view.pendingDisclosure != null;
  const mode = approvalPending
    ? "approval"
    : view.queueingInput
      ? "queue"
      : view.runStatus === "idle"
        ? "ready"
        : view.runStatus;
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
        [modelLabel ?? null, tokenSegment(view.usage), view.safeCode]
          .filter((part): part is string => part !== null && part !== undefined && part !== "")
          .join(" · "),
        Math.max(1, Math.floor(props.width / 2) - 1),
      ),
    ),
  );
}

/**
 * Context occupancy.
 *
 * Shown before the token total because it is the figure that changes during a Run:
 * the total only exists once the Run ends. A window that is unknown shows the raw
 * count instead of a percentage, because a percentage without a denominator would
 * be invented.
 */
function meterSegment(meter: TuiViewState["meter"]): string | null {
  if (meter === null || meter.used === 0) return null;
  if (meter.window === null || meter.fraction === null) return `ctx ${compact(meter.used)}`;
  const percent = Math.floor(meter.fraction * 100);
  return `ctx ${percent}%${meter.atCompaction ? " !" : ""}`;
}

/**
 * Token counts for the last finished Run.
 *
 * Absent means the provider reported nothing, which is shown as nothing rather
 * than as a zero count. `cached` is a subset of the input count, shown because it
 * explains a large prompt with a small effective cost.
 */
function tokenSegment(usage: TuiViewState["usage"]): string | null {
  if (usage === null || usage === undefined) return null;
  const total = usage.inputTokens + usage.outputTokens;
  if (total === 0) return null;
  const cached =
    usage.cachedInputTokens === undefined ? "" : ` (${compact(usage.cachedInputTokens)} cached)`;
  return `${compact(total)} tok${cached}`;
}

/** Thousands as `1.2k`, so a footer segment stays short. */
function compact(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}
