import { Box, Text, useInput, usePaste } from "ink";
import { createElement, useState } from "react";
import { ActivityIndicator } from "./activity-indicator.js";
import { Brand, clipText, colorProps, useViewport, wrapText } from "./chrome.js";
import { CommandMenu } from "./command-menu.js";
import { CredentialScreen } from "./credential-screen.js";
import { InitPanel } from "./init-panel.js";
import { LocalPanel } from "./local-panel.js";
import { McpPanel } from "./mcp-panel.js";
import { colorFor, detectCapabilities } from "./palette.js";
import { SessionList } from "./session-list.js";
import { useTerminalWheel } from "./terminal-wheel.js";
import { characters, editText } from "./text-edit.js";
import { TextInput } from "./text-input.js";
import { COMPOSER_COMMANDS, commandEnabled } from "./view-model.js";
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
export function App(props) {
    const { view } = props;
    const [editor, setEditor] = useState({ value: "", cursor: 0 });
    /**
     * Focused approval button. Focus is not a reply: the Run stays suspended
     * until Enter confirms the selected action. A new approval starts on Approve
     * for tool calls and on Cancel for sensitive redisclosure.
     */
    const approvalKey = view.pendingApproval?.approvalId ?? view.pendingDisclosure?.disclosureId ?? null;
    const approvalDefault = view.pendingDisclosure === null ? "approve" : "deny";
    const [approvalSelection, setApprovalSelection] = useState(null);
    const canApprove = view.pendingDisclosure !== null || view.pendingApprovalPreview !== null;
    const selectedApproval = approvalKey !== null && approvalSelection?.key === approvalKey
        ? approvalSelection.choice
        : approvalDefault;
    const approvalChoice = canApprove ? selectedApproval : "deny";
    /**
     * Images pasted with Ctrl+V and not yet sent.
     *
     * A terminal paste carries text only, so the image is read from the system
     * clipboard when the user presses the key. It is held here until the next submit
     * and then cleared, which matches how a text draft behaves.
     */
    const [pastedImages, setPastedImages] = useState([]);
    const [imageNotice, setImageNotice] = useState(null);
    const draft = editor.value;
    const [scroll, setScroll] = useState(null);
    const [commandIndex, setCommandIndex] = useState(0);
    const [dismissedCommands, setDismissedCommands] = useState(false);
    const [expandedTools, setExpandedTools] = useState(new Set());
    const [selectedTool, setSelectedTool] = useState(null);
    const viewport = useViewport(props.viewport);
    const width = Math.max(1, viewport.columns - 4);
    const lobby = view.runStatus === "idle" && view.transcript.length === 0 && view.todo === null;
    const lobbyWidth = Math.max(1, Math.min(84, Math.max(50, Math.floor((width * 2) / 3)), width));
    const commands = !dismissedCommands &&
        view.pendingApproval === null &&
        view.pendingDisclosure == null &&
        view.pendingQuestion === null &&
        draft.startsWith("/")
        ? COMPOSER_COMMANDS.filter((command) => command.name.startsWith(draft))
        : [];
    const selectedCommand = Math.min(commandIndex, Math.max(0, commands.length - 1));
    const bodyRows = Math.max(1, viewport.rows - 9);
    const lines = documentLines(view, width, expandedTools, selectedTool, approvalChoice);
    const maxStart = Math.max(0, lines.length - bodyRows);
    const start = scroll === null ? maxStart : Math.min(scroll, maxStart);
    const capabilities = props.capabilities ??
        detectCapabilities({
            noColor: process.env["NO_COLOR"] !== undefined,
            colorterm: process.env["COLORTERM"],
            term: process.env["TERM"],
            force: process.env["LYCWL_COLOR"],
            windowsTerminal: process.env["WT_SESSION"] !== undefined,
        });
    function selectApproval(choice) {
        if (approvalKey === null)
            return;
        setApprovalSelection({ key: approvalKey, choice });
    }
    function scrollBy(delta) {
        setScroll((current) => {
            const top = current === null ? maxStart : Math.min(current, maxStart);
            const next = Math.max(0, Math.min(maxStart, top + delta));
            return next === maxStart ? null : next;
        });
    }
    function toggleTool(id) {
        setSelectedTool(id);
        setScroll(start);
        setExpandedTools((current) => {
            const next = new Set(current);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }
    function submit(text) {
        const images = pastedImages;
        setEditor({ value: "", cursor: 0 });
        setPastedImages([]);
        setImageNotice(null);
        setScroll(null);
        void Promise.resolve(props.onSubmit(text, images.length === 0 ? undefined : images)).then((accepted) => {
            if (accepted === false)
                setEditor((current) => current.value === "" ? { value: text, cursor: characters(text).length } : current);
        });
    }
    useInput((input, key) => {
        if (view.localPanel != null)
            return;
        if (key.ctrl && input === "c") {
            props.onCancelRun();
            return;
        }
        if (approvalKey !== null) {
            // Arrows choose between Approve and Cancel only while the composer is
            // empty. With text present they keep their normal cursor-editing meaning,
            // so queued input remains usable during a wait.
            if (draft.length === 0 && key.leftArrow) {
                selectApproval(canApprove ? "approve" : "deny");
                return;
            }
            if (draft.length === 0 && key.rightArrow) {
                selectApproval("deny");
                return;
            }
            if (key.return) {
                const text = draft.trim();
                if (text === "a" || text === "d") {
                    setEditor({ value: "", cursor: 0 });
                    setScroll(null);
                    if (text === "a" && canApprove)
                        props.onApprove();
                    else if (text === "d")
                        props.onDeny();
                    return;
                }
                if (text.length === 0) {
                    if (approvalChoice === "approve" && canApprove)
                        props.onApprove();
                    else
                        props.onDeny();
                    return;
                }
                // Non-empty text falls through to the normal composer path, which queues
                // it instead of treating Enter as a decision.
            }
        }
        if (key.ctrl && input === "v") {
            // A terminal delivers the key, not the image. Reading the clipboard here is
            // the only way to see a pasted picture.
            const read = props.onPasteImage;
            if (read === undefined)
                return;
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
            const id = selectedTool !== null &&
                view.transcript.some((entry) => entry.id === selectedTool && entry.tool !== undefined)
                ? selectedTool
                : visibleTools.at(-1)?.toolId;
            if (id !== undefined && id !== null)
                toggleTool(id);
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
                setCommandIndex((selectedCommand + (key.upArrow ? -1 : 1) + commands.length) % commands.length);
                return;
            }
            const command = commands[selectedCommand];
            if (key.tab && command !== undefined) {
                setEditor({ value: command.name, cursor: command.name.length });
                return;
            }
            if (key.return && command !== undefined && !commandEnabled(view, command))
                return;
            if (key.return && command !== undefined) {
                submit(command.name);
                return;
            }
        }
        if (key.return) {
            const text = draft.trim();
            setEditor({ value: "", cursor: 0 });
            setScroll(null);
            if (text.length === 0)
                return;
            if (view.pendingQuestion !== null)
                props.onAnswer(text);
            else
                submit(text);
            return;
        }
        setCommandIndex(0);
        setDismissedCommands(false);
        setEditor((current) => editText(current, input, key));
    });
    usePaste((text) => {
        if (view.localPanel != null)
            return;
        setCommandIndex(0);
        setDismissedCommands(false);
        setEditor((current) => editText(current, text, {}));
    });
    useTerminalWheel((event) => {
        if (view.localPanel != null)
            return;
        if (!lobby &&
            event.row >= 3 &&
            event.row < 3 + bodyRows &&
            event.column <= viewport.columns) {
            scrollBy(event.direction === "up" ? -3 : 3);
        }
    }, (event) => {
        if (view.localPanel != null || lobby || event.column < 3 || event.column > width + 2)
            return;
        const offset = event.row - 3;
        if (offset < 0 || offset >= bodyRows)
            return;
        const id = lines[start + offset]?.toolId;
        if (id !== undefined)
            toggleTool(id);
    });
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
        return h(Box, {
            width: viewport.columns,
            height: Math.max(1, viewport.rows - 1),
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
        }, h(Brand, {
            capabilities,
            width: lobbyWidth,
            compact: viewport.rows < 20,
            animated: props.animated,
        }), h(Box, { width: lobbyWidth, flexDirection: "column", marginTop: 1 }, h(Composer, {
            view,
            editor,
            capabilities,
            width: lobbyWidth,
            commands,
            selectedCommand,
            commandRows: Math.max(1, Math.min(6, Math.floor((viewport.rows - 5) / 2))),
            attachedImages: pastedImages.length,
            imageNotice,
            animated: props.animated,
        }), h(Footer, {
            view,
            capabilities,
            modelLabel: props.modelLabel,
            modeLabel: props.modeLabel,
            width: lobbyWidth,
        })), viewport.rows < 16
            ? null
            : h(Box, { marginTop: 1 }, h(Text, colorProps(colorFor("dim", capabilities)), "lycwl  ·  0.1.0")));
    }
    return h(Box, {
        flexDirection: "column",
        width: viewport.columns,
        height: Math.max(1, viewport.rows - 1),
        paddingX: 2,
        overflow: "hidden",
    }, h(TitleBar, { view, capabilities }), h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(width)), h(Box, { flexDirection: "column", height: bodyRows, flexShrink: 0 }, ...lines.slice(start, start + bodyRows).map((line, index) => h(Text, {
        key: `${start + index}`,
        ...colorProps(colorFor(line.role, capabilities)),
        ...(line.bold ? { bold: true } : {}),
    }, line.text || " "))), h(Text, colorProps(colorFor("faint", capabilities)), lines.length > bodyRows
        ? clipText(`${start + 1}–${Math.min(start + bodyRows, lines.length)} / ${lines.length}  ·  Scroll / PgUp / PgDn`, width)
        : "─".repeat(width)), h(Composer, {
        view,
        editor,
        capabilities,
        width,
        commands,
        selectedCommand,
        commandRows: Math.max(1, Math.min(6, viewport.rows - 6)),
        attachedImages: pastedImages.length,
        imageNotice,
        animated: props.animated,
    }), h(Footer, {
        view,
        capabilities,
        modelLabel: props.modelLabel,
        modeLabel: props.modeLabel,
        width,
    }));
}
/** Wrap rather than truncate: approval commands and diffs remain available by paging. */
function documentLines(view, width, expanded, selected, approvalChoice) {
    const lines = [];
    function append(text, role, bold = false) {
        lines.push(...wrapText(displayText(text), width).map((line) => ({ text: line, role, bold })));
    }
    function appendApprovalButtons(choice, canApprove, approveLabel) {
        const approve = canApprove
            ? `${choice === "approve" ? "▶ " : "  "}${approveLabel}`
            : `  ${approveLabel} (unavailable)`;
        const deny = `${choice === "deny" ? "▶ " : "  "}Cancel`;
        append(`[ ${approve} ]   [ ${deny} ]`, "secondary", true);
        append("empty input: ←/→ select · Enter confirms", "dim");
    }
    for (const entry of view.transcript) {
        if (entry.kind === "tool" && entry.tool !== undefined) {
            const isExpanded = expanded.has(entry.id);
            const role = entry.status === "failed" || entry.status === "denied" || entry.status === "outcome_unknown"
                ? "tertiary"
                : entry.status === "succeeded"
                    ? "success"
                    : "secondary";
            const prefix = `${selected === entry.id ? "▸" : " "} ${isExpanded ? "▾" : "▸"} `;
            const suffix = ` · ${entry.status ?? "requested"}`;
            lines.push({
                text: clipText(`${prefix}${clipText(displayText(entry.tool.summary), Math.max(1, width - prefix.length - suffix.length))}${suffix}`, width),
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
        const role = entry.kind === "user"
            ? "primary"
            : entry.kind === "assistant"
                ? "success"
                : entry.status === "failed" || entry.status === "denied"
                    ? "tertiary"
                    : "dim";
        const label = entry.kind === "user"
            ? `you${entry.status === null ? "" : ` · ${entry.status}`}`
            : entry.kind === "assistant"
                ? `agent${entry.status === "streaming" ? " · streaming" : ""}`
                : entry.kind === "tool"
                    ? `tool${entry.status === null ? "" : `·${entry.status}`}`
                    : "sys";
        append(`▌ ${label}`, role, true);
        append(entry.status === "streaming" ? `${entry.text}▍` : entry.text, "dim");
        append("", "faint");
    }
    if (view.todo !== null) {
        append("plan", "secondary", true);
        for (const item of view.todo.items)
            append(`${marker(item.state)} ${item.content}`, item.state === "completed" ? "success" : "dim");
    }
    if (view.pendingDisclosure != null) {
        append("Sensitive context redisclosure", "secondary", true);
        for (const line of view.pendingDisclosure.safePreview.split("\n"))
            append(line, "dim");
        appendApprovalButtons(approvalChoice, true, "Consent");
    }
    if (view.pendingApproval !== null) {
        append(`▌ approval required · ${view.pendingApproval.toolName}`, "secondary", true);
        if (view.pendingApprovalPreview === null)
            append("preview unavailable: the exact operation is not recorded", "tertiary");
        else
            for (const line of view.pendingApprovalPreview)
                append(line, "dim");
        appendApprovalButtons(approvalChoice, view.pendingApprovalPreview !== null, "Approve");
    }
    if (view.pendingQuestion !== null) {
        const question = view.pendingQuestion;
        append(`▌ question · ${question.question}`, "secondary", true);
        for (const option of question.options)
            append(`${option.id}) ${option.label}`, "dim");
        append(question.answerType === "confirmation"
            ? 'type "yes" or "no"'
            : question.answerType === "text"
                ? "type an answer"
                : question.multiple
                    ? "type ids or labels, comma separated"
                    : "type an option id or label", "faint");
        if (view.answerError !== null)
            append(`not accepted: ${view.answerError}`, "tertiary");
    }
    return lines;
}
function displayText(text) {
    return text.replace(/[\p{Control}\p{Bidi_Control}]/gu, (character) => character === "\n" || character === "\r"
        ? character
        : character === "\t"
            ? "    "
            : `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}
/** One-line title with the run state on the right, as the reference does. */
function TitleBar(props) {
    const { view, capabilities } = props;
    const state = view.waitingKind === null ? view.runStatus : `waiting:${view.waitingKind}`;
    const stateColor = view.runStatus === "failed"
        ? colorFor("tertiary", capabilities)
        : view.waitingKind !== null
            ? colorFor("secondary", capabilities)
            : view.runStatus === "completed"
                ? colorFor("success", capabilities)
                : colorFor("dim", capabilities);
    return h(Box, { justifyContent: "space-between" }, h(Text, { bold: true, ...colorProps(colorFor("primary", capabilities)) }, "lycwl"), h(Text, colorProps(stateColor), state));
}
function marker(state) {
    if (state === "completed")
        return "[x]";
    if (state === "in_progress")
        return "[>]";
    if (state === "cancelled")
        return "[-]";
    return "[ ]";
}
/**
 * The composer, with the lane bar on its left edge.
 *
 * The bar is the reference's most recognisable element: it marks where input goes and
 * carries the accent colour, so the input area is identifiable without a label.
 */
function Composer(props) {
    const { view, editor, capabilities } = props;
    const accent = colorFor(view.queueingInput ? "secondary" : "primary", capabilities);
    const approvalPending = view.pendingDisclosure != null || view.pendingApproval !== null;
    const hint = approvalPending
        ? editor.value.length === 0
            ? "←/→ select · Enter confirms"
            : 'Enter queues · "a"/"d" decide'
        : view.pendingQuestion !== null
            ? "Enter answer"
            : view.queueingInput
                ? "queued as supplementary input for the running run"
                : view.canSubmit
                    ? "Enter submits · / commands · Ctrl+C cancels"
                    : "run is busy";
    return h(Box, { flexDirection: "column", marginTop: 1, flexShrink: 0 }, h(Box, null, h(Text, colorProps(accent), "▌ "), h(Text, colorProps(accent), view.queueingInput ? "queue" : "task"), h(Text, null, " › "), 
    // The attachment marker sits before the input so the user sees that the next
    // send will carry an image before typing the task.
    props.attachedImages === 0
        ? null
        : h(Text, colorProps(colorFor("secondary", capabilities)), `[image ×${props.attachedImages}] `), h(TextInput, {
        value: editor.value,
        cursor: editor.cursor,
        width: Math.max(1, props.width - (view.queueingInput ? 10 : 9)),
        color: accent,
    })), h(Box, { marginLeft: 2 }, view.activity === null
        ? h(Text, colorProps(colorFor("faint", capabilities)), clipText(props.imageNotice ?? view.commandNotice ?? hint, Math.max(1, props.width - 2)))
        : h(ActivityIndicator, {
            activity: view.activity,
            capabilities,
            width: Math.max(1, props.width - 2),
            animated: props.animated,
        })), h(CommandMenu, {
        commands: props.commands,
        selected: props.selectedCommand,
        enabled: view.canSubmit,
        width: props.width,
        capabilities,
        rows: props.commandRows,
    }));
}
/**
 * Footer: mode on the left, model, tokens and status on the right.
 *
 * Clip each segment independently so they cannot collide on narrow terminals.
 */
function Footer(props) {
    const { view, capabilities, modelLabel } = props;
    const mode = view.queueingInput ? "queue" : view.runStatus === "idle" ? "ready" : view.runStatus;
    const accent = colorFor(view.runStatus === "failed" ? "tertiary" : "primary", capabilities);
    return h(Box, { marginTop: 1, justifyContent: "space-between" }, h(Text, { bold: true, ...colorProps(accent) }, clipText(props.modeLabel === undefined ? mode : `${props.modeLabel} · ${mode}`, Math.max(1, Math.floor(props.width / 2)))), h(Text, colorProps(colorFor("dim", capabilities)), clipText([modelLabel ?? null, tokenSegment(view.usage), view.safeCode]
        .filter((part) => part !== null && part !== undefined && part !== "")
        .join(" · "), Math.max(1, Math.floor(props.width / 2) - 1))));
}
/**
 * Context occupancy.
 *
 * Shown before the token total because it is the figure that changes during a Run:
 * the total only exists once the Run ends. A window that is unknown shows the raw
 * count instead of a percentage, because a percentage without a denominator would
 * be invented.
 */
function meterSegment(meter) {
    if (meter === null || meter.used === 0)
        return null;
    if (meter.window === null || meter.fraction === null)
        return `ctx ${compact(meter.used)}`;
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
function tokenSegment(usage) {
    if (usage === null || usage === undefined)
        return null;
    const total = usage.inputTokens + usage.outputTokens;
    if (total === 0)
        return null;
    const cached = usage.cachedInputTokens === undefined ? "" : ` (${compact(usage.cachedInputTokens)} cached)`;
    return `${compact(total)} tok${cached}`;
}
/** Thousands as `1.2k`, so a footer segment stays short. */
function compact(value) {
    if (value < 1_000)
        return String(value);
    if (value < 1_000_000)
        return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}
