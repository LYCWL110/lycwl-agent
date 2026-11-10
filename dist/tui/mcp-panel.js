import { Box, Text, useInput } from "ink";
import { createElement as h, useState } from "react";
import { clipText, colorProps } from "./chrome.js";
import { colorFor } from "./palette.js";
import { editText } from "./text-edit.js";
import { TextInput } from "./text-input.js";
const EMPTY = { value: "", cursor: 0 };
export function McpPanel(props) {
    const [selected, setSelected] = useState(0);
    const [form, setForm] = useState(null);
    const width = Math.max(1, props.viewport.columns - 4);
    const servers = props.servers ?? [];
    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            props.onClose();
            return;
        }
        if (form !== null) {
            if (key.escape) {
                setForm(null);
                return;
            }
            if (key.tab || key.downArrow || key.upArrow) {
                const delta = key.upArrow ? 2 : 1;
                setForm({ ...form, field: ((form.field + delta) % 3) });
                return;
            }
            if (key.return) {
                const serverId = form.serverId.value.trim();
                const command = form.command.value.trim();
                if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(serverId)) {
                    setForm({ ...form, error: "id: lowercase letters, digits and hyphens" });
                    return;
                }
                if (command.length === 0) {
                    setForm({ ...form, error: "command is required" });
                    return;
                }
                if (/[&|<>^%\r\n]/u.test(command)) {
                    setForm({ ...form, error: "command may not contain shell metacharacters" });
                    return;
                }
                props.onAdd({
                    serverId,
                    command,
                    args: form.args.value
                        .split(/\s+/u)
                        .map((arg) => arg.trim())
                        .filter((arg) => arg.length > 0),
                });
                setForm(null);
                return;
            }
            const current = form.field === 0 ? form.serverId : form.field === 1 ? form.command : form.args;
            const edited = editText(current, input, key);
            if (edited.value.length > 256)
                return;
            setForm({
                ...form,
                error: null,
                ...(form.field === 0
                    ? { serverId: edited }
                    : form.field === 1
                        ? { command: edited }
                        : { args: edited }),
            });
            return;
        }
        if (key.escape) {
            props.onClose();
            return;
        }
        if (props.busy)
            return;
        if (key.upArrow)
            setSelected((value) => Math.max(0, value - 1));
        if (key.downArrow)
            setSelected((value) => Math.min(Math.max(0, servers.length - 1), value + 1));
        if (input === "a") {
            setForm({ serverId: EMPTY, command: EMPTY, args: EMPTY, field: 0, error: null });
            return;
        }
        if ((input === "d" || input === "x") && servers.length > 0) {
            const entry = servers[Math.min(selected, servers.length - 1)];
            if (entry !== undefined)
                props.onRemove(entry.serverId);
        }
    });
    return h(Box, {
        width: props.viewport.columns,
        height: Math.max(1, props.viewport.rows - 1),
        flexDirection: "column",
        paddingX: 2,
        overflow: "hidden",
    }, h(Text, { bold: true, ...colorProps(colorFor("primary", props.capabilities)) }, "MCP servers"), h(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden" }, ...(form !== null
        ? renderForm(form, props, width)
        : renderList(servers, props, selected, width))), h(Text, colorProps(colorFor("tertiary", props.capabilities)), clipText(props.error ?? props.notice ?? "", width)), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText(form !== null
        ? "Tab next field  Enter save  Esc cancel"
        : "a add  d remove  Esc close  (a server starts only after approval at launch)", width)));
}
function renderList(servers, props, selected, width) {
    if (props.error !== null) {
        return [
            h(Text, { key: "err", ...colorProps(colorFor("tertiary", props.capabilities)) }, clipText(`unavailable: ${props.error}`, width)),
        ];
    }
    if (servers.length === 0) {
        return [
            h(Text, { key: "none", ...colorProps(colorFor("faint", props.capabilities)) }, clipText("no MCP servers declared", width)),
            h(Text, { key: "hint", ...colorProps(colorFor("dim", props.capabilities)) }, clipText("press a to declare one", width)),
        ];
    }
    return servers.flatMap((entry, index) => [
        h(Text, {
            key: entry.serverId,
            bold: index === selected,
            inverse: index === selected,
            ...colorProps(colorFor("primary", props.capabilities)),
        }, clipText(`${index === selected ? ">" : " "} ${entry.serverId}`, width)),
        h(Text, { key: `${entry.serverId}-c`, ...colorProps(colorFor("dim", props.capabilities)) }, clipText(`    ${entry.command}${entry.args.length === 0 ? "" : ` ${entry.args.join(" ")}`}`, width)),
    ]);
}
function renderForm(form, props, width) {
    const label = (index, text) => h(Text, {
        key: `l-${index}`,
        ...colorProps(colorFor(form.field === index ? "primary" : "dim", props.capabilities)),
    }, `${form.field === index ? ">" : " "} ${text}`);
    const field = (index) => {
        const value = index === 0 ? form.serverId : index === 1 ? form.command : form.args;
        return h(Box, { key: `f-${index}` }, h(Text, null, "  "), h(TextInput, { ...value, width: Math.max(1, width - 4) }));
    };
    return [
        label(0, "id"),
        field(0),
        label(1, "command"),
        field(1),
        label(2, "arguments (space separated)"),
        field(2),
        ...(form.error === null
            ? []
            : [
                h(Text, { key: "form-err", ...colorProps(colorFor("tertiary", props.capabilities)) }, clipText(form.error, width)),
            ]),
    ];
}
