import { Box, Text, useInput } from "ink";
import { createElement as h, useState } from "react";
import { clipText, colorProps } from "./chrome.js";
import { colorFor } from "./palette.js";
import { editText } from "./text-edit.js";
import { TextInput } from "./text-input.js";
export function SessionList(props) {
    const [selected, setSelected] = useState(0);
    const [offset, setOffset] = useState(0);
    const [mode, setMode] = useState({ kind: "list" });
    const width = Math.max(1, props.viewport.columns - 4);
    const rows = Math.max(1, props.viewport.rows - 6);
    const sessions = props.sessions ?? [];
    const visible = sessions.slice(offset, offset + rows);
    function move(delta) {
        const next = Math.max(0, Math.min(sessions.length - 1, selected + delta));
        setSelected(next);
        setOffset((current) => {
            if (next < current)
                return next;
            if (next >= current + rows)
                return next - rows + 1;
            return current;
        });
    }
    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            props.onClose();
            return;
        }
        if (props.busy)
            return;
        if (mode.kind === "rename") {
            if (key.escape) {
                setMode({ kind: "list" });
                return;
            }
            if (key.return) {
                // An empty field clears the title, which restores the derived label.
                const value = mode.edit.value.trim();
                props.onRename(mode.sessionId, value.length === 0 ? null : value);
                setMode({ kind: "list" });
                return;
            }
            const edited = editText(mode.edit, input, key);
            if (edited.value.length <= 80)
                setMode({ ...mode, edit: edited });
            return;
        }
        if (mode.kind === "confirm_delete") {
            if (input === "y") {
                props.onDelete(mode.sessionId);
                setMode({ kind: "list" });
                return;
            }
            if (key.escape || input === "n")
                setMode({ kind: "list" });
            return;
        }
        if (key.escape) {
            props.onClose();
            return;
        }
        if (key.upArrow)
            move(-1);
        if (key.downArrow)
            move(1);
        if (key.pageUp)
            move(-rows);
        if (key.pageDown)
            move(rows);
        const entry = sessions[selected];
        if (key.return && entry !== undefined) {
            props.onResume(entry.sessionId);
            return;
        }
        if (entry === undefined)
            return;
        if (input === "r") {
            setMode({
                kind: "rename",
                sessionId: entry.sessionId,
                edit: { value: entry.title ?? "", cursor: (entry.title ?? "").length },
            });
            return;
        }
        if (input === "d")
            setMode({ kind: "confirm_delete", sessionId: entry.sessionId });
    });
    return h(Box, {
        width: props.viewport.columns,
        height: Math.max(1, props.viewport.rows - 1),
        flexDirection: "column",
        paddingX: 2,
        overflow: "hidden",
    }, h(Text, { bold: true, ...colorProps(colorFor("primary", props.capabilities)) }, "Sessions"), h(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden" }, ...renderBody(props, visible, selected - offset, mode, width)), h(Text, colorProps(colorFor("tertiary", props.capabilities)), clipText(props.error ?? props.notice ?? "", width)), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText(footerFor(mode), width)));
}
function footerFor(mode) {
    if (mode.kind === "rename")
        return "Enter save  Esc cancel  (empty clears the title)";
    if (mode.kind === "confirm_delete")
        return "y confirm delete  n / Esc cancel";
    return "Enter resume  r rename  d delete  Esc close";
}
function renderBody(props, visible, selected, mode, width) {
    if (props.error !== null) {
        return [
            h(Text, { key: "err", ...colorProps(colorFor("tertiary", props.capabilities)) }, clipText(`unavailable: ${props.error}`, width)),
        ];
    }
    if (visible.length === 0) {
        return [
            h(Text, { key: "none", ...colorProps(colorFor("faint", props.capabilities)) }, clipText("no recorded sessions", width)),
        ];
    }
    const lines = [];
    for (const [index, entry] of visible.entries()) {
        const active = index === selected;
        lines.push(h(Text, {
            key: entry.sessionId,
            inverse: active,
            bold: active,
            ...colorProps(colorFor("primary", props.capabilities)),
        }, clipText(`${active ? ">" : " "} ${entry.label}${entry.current ? "  (current)" : ""}`, width)));
        lines.push(h(Text, { key: `${entry.sessionId}-m`, ...colorProps(colorFor("dim", props.capabilities)) }, clipText(`    ${entry.sessionId}  ${formatWhen(entry.modifiedAtUtc)}  ${formatBytes(entry.bytes)}`, width)));
        if (active && mode.kind === "rename" && mode.sessionId === entry.sessionId) {
            lines.push(h(Box, { key: `${entry.sessionId}-rename` }, h(Text, null, "    title: "), h(TextInput, { ...mode.edit, width: Math.max(1, width - 12) })));
        }
        if (active && mode.kind === "confirm_delete" && mode.sessionId === entry.sessionId) {
            lines.push(h(Text, {
                key: `${entry.sessionId}-confirm`,
                ...colorProps(colorFor("tertiary", props.capabilities)),
            }, clipText("    delete this session and its attachments? y/n", width)));
        }
    }
    return lines;
}
/**
 * Show a local date and time, with a relative hint for recent activity.
 *
 * The relative form is what makes the sort order legible at a glance: a list
 * ordered by time is hard to read when every row shows an absolute timestamp.
 */
function formatWhen(iso, nowMs = Date.now()) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return iso;
    const pad = (value) => String(value).padStart(2, "0");
    const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const relative = formatRelative(date.getTime(), nowMs);
    return relative === null ? absolute : `${absolute}  (${relative})`;
}
/** Coarse age: enough to read the order, not a precise interval. */
function formatRelative(thenMs, nowMs) {
    const elapsed = nowMs - thenMs;
    // A future timestamp means a clock change, not a prediction; show no age claim.
    if (elapsed < 0)
        return null;
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1)
        return "just now";
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days}d ago`;
    return null;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
