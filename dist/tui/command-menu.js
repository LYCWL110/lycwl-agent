import { Box, Text } from "ink";
import { createElement as h } from "react";
import { cellWidth, clipText, colorProps } from "./chrome.js";
import { colorFor } from "./palette.js";
export function CommandMenu(props) {
    if (props.commands.length === 0)
        return null;
    const { capabilities, width } = props;
    const count = Math.min(props.rows, props.commands.length);
    const offset = Math.max(0, Math.min(props.selected - count + 1, props.commands.length - count));
    const innerWidth = Math.max(1, width - 2);
    const nameWidth = Math.min(Math.max(...props.commands.map((command) => cellWidth(command.name))) + 2, Math.max(1, Math.floor(innerWidth / 2)));
    return h(Box, {
        position: "absolute",
        bottom: 2,
        left: 0,
        width,
        height: count,
        flexDirection: "column",
        backgroundColor: capabilities.depth === "mono" ? undefined : "#202020",
    }, ...props.commands.slice(offset, offset + count).map((command, index) => {
        const selected = offset + index === props.selected;
        const highlight = selected && capabilities.depth !== "mono";
        const foreground = highlight ? "black" : colorFor("dim", capabilities);
        const description = clipText(props.enabled || !command.idleOnly
            ? command.description
            : `${command.description} (idle only)`, Math.max(1, innerWidth - nameWidth));
        return h(Box, {
            key: command.name,
            width,
            height: 1,
            flexShrink: 0,
            paddingX: 1,
            backgroundColor: highlight ? colorFor("secondary", capabilities) : undefined,
        }, h(Text, {
            inverse: selected && capabilities.depth === "mono",
            ...colorProps(foreground),
        }, clipText(command.name, nameWidth).padEnd(nameWidth), description, " ".repeat(Math.max(0, innerWidth - nameWidth - cellWidth(description)))));
    }));
}
