import { Box, Text, useInput } from "ink";
import { createElement as h } from "react";
import { clipText, colorProps, wrapText } from "./chrome.js";
import { colorFor } from "./palette.js";
export function InitPanel(props) {
    const width = Math.max(1, props.viewport.columns - 4);
    const rows = Math.max(1, props.viewport.rows - 8);
    useInput((input, key) => {
        if (props.busy)
            return;
        if (key.escape || input === "n" || input === "N") {
            props.onCancel();
            return;
        }
        if (key.return || input === "y" || input === "Y")
            props.onConfirm();
    });
    const headLines = props.preview.head
        .split("\n")
        .slice(0, rows)
        .flatMap((line) => wrapText(line, width));
    return h(Box, {
        width: props.viewport.columns,
        height: Math.max(1, props.viewport.rows - 1),
        flexDirection: "column",
        paddingX: 2,
        overflow: "hidden",
    }, h(Text, { bold: true, ...colorProps(colorFor("primary", props.capabilities)) }, "Create AGENTS.md"), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText(`path: ${props.preview.path}`, width)), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText(`bytes: ${props.preview.bytes}   detected: ${props.preview.detected.length === 0 ? "unknown stack" : props.preview.detected.join(", ")}`, width)), h(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", marginTop: 1 }, ...headLines.map((line, index) => h(Text, { key: index, ...colorProps(colorFor("faint", props.capabilities)) }, line))), h(Text, colorProps(colorFor("tertiary", props.capabilities)), clipText(props.notice ?? "", width)), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText("Enter / y create   Esc / n cancel", width)));
}
