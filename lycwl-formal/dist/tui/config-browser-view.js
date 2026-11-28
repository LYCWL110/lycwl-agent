import { Box, Text, useInput } from "ink";
import { createElement as h } from "react";
import { ConfigChrome, clipText, colorProps, useViewport } from "./chrome.js";
import { applyKey, BROWSER_LIMITS, contextNotice, filteredModels, reasoningChoices, reasoningNotice, visibleWindow, } from "./config-browser.js";
import { colorFor, rowStyle } from "./palette.js";
import { TextInput } from "./text-input.js";
/** Shared Miyu chrome, independent column focus and a separate selection marker. */
export function ConfigBrowser(props) {
    const { state, capabilities } = props;
    const viewport = useViewport(props.viewport);
    const width = Math.max(1, Math.min(84, viewport.columns - 4));
    const stacked = width < 62;
    const paired = stacked &&
        width >= 28 &&
        (state.activeColumn === "model" || state.activeColumn === "reasoning");
    const providerWidth = stacked ? width : Math.floor(width * 0.16);
    const protocolWidth = stacked ? width : Math.floor(width * 0.3);
    const reasoningWidth = stacked && !paired ? width : 13;
    const modelWidth = stacked
        ? paired
            ? width - reasoningWidth - 1
            : width
        : width - providerWidth - protocolWidth - reasoningWidth - 3;
    const efforts = reasoningChoices(state);
    const editing = state.filterMode || state.modelInput !== null;
    useInput((input, key) => {
        if (props.busy)
            return;
        if (!editing && input === "e" && !key.ctrl && !key.meta) {
            props.onEdit?.();
            return;
        }
        if (!editing && key.ctrl && input === "r") {
            props.onRefresh?.();
            return;
        }
        const translated = translateKey(input, key);
        if (translated === null)
            return;
        const outcome = applyKey(state, translated);
        if (outcome.cancel)
            props.onCancel();
        else if (outcome.commit !== null)
            props.onCommit(outcome.commit);
        else if (outcome.state !== state)
            props.onState(outcome.state);
    });
    const models = filteredModels(state);
    const columns = [
        {
            title: "Provider",
            focused: state.activeColumn === "provider",
            width: providerWidth,
            values: [state.providerLabel],
            offset: 0,
            selected: 0,
        },
        {
            title: "Protocol",
            focused: state.activeColumn === "protocol",
            width: protocolWidth,
            values: state.protocols,
            offset: state.scroll.protocol,
            selected: state.protocolIndex,
        },
        {
            title: "Model",
            focused: state.activeColumn === "model",
            width: modelWidth,
            values: models.map((entry) => entry.id),
            offset: state.scroll.model,
            selected: state.modelIndex,
        },
        {
            title: "Reasoning",
            focused: state.activeColumn === "reasoning",
            width: reasoningWidth,
            values: efforts,
            offset: 0,
            selected: efforts.indexOf(state.reasoningEffort),
        },
    ];
    return h(ConfigChrome, { capabilities, viewport, title: "Provider / Model / Reasoning", animated: props.animated }, h(Box, { flexDirection: "column" }, h(Text, { bold: true }, "Provider configuration"), props.endpoint === undefined
        ? null
        : h(Text, colorProps(colorFor("dim", capabilities)), clipText(props.endpoint, width)), h(Box, { flexDirection: "row", marginTop: stacked ? 0 : 1, gap: 1 }, ...columns
        .filter((column) => !stacked ||
        column.focused ||
        (paired && (column.title === "Model" || column.title === "Reasoning")))
        .map((column) => h(Box, {
        key: column.title,
        width: column.width,
        flexDirection: "column",
        minHeight: stacked ? undefined : BROWSER_LIMITS.visibleRows + 1,
    }, h(Text, {
        bold: true,
        ...colorProps(colorFor(column.focused ? "secondary" : "dim", capabilities)),
    }, clipText(column.title, column.width)), h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(column.width)), ...visibleWindow(column.values, column.offset).map((value, index) => {
        return h(Row, 
        // biome-ignore lint/correctness/useJsxKeyInIterable: The React createElement props below include a stable key.
        {
            key: `${column.title}-${value}`,
            text: value,
            width: column.width,
            focused: column.focused,
            selected: column.offset + index === column.selected,
            capabilities,
        });
    }), column.values.length === 0
        ? h(Text, colorProps(colorFor("dim", capabilities)), "(no models)")
        : null))), h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(width)), h(Text, colorProps(colorFor("dim", capabilities)), reasoningNotice(state)), h(Text, colorProps(colorFor("dim", capabilities)), contextNotice(state, props.contextOverride)), !efforts.includes(state.reasoningEffort)
        ? h(Text, colorProps(colorFor("tertiary", capabilities)), `Current ${state.reasoningEffort}: select a listed level`)
        : null, state.modelInput !== null
        ? h(Box, null, h(Text, colorProps(colorFor("primary", capabilities)), "Model id: "), h(TextInput, {
            value: state.modelInput,
            cursor: state.modelCursor,
            width: Math.max(1, width - 10),
            color: colorFor("primary", capabilities),
        }))
        : state.filterMode
            ? h(Box, null, h(Text, colorProps(colorFor("primary", capabilities)), "Filter: "), h(TextInput, {
                value: state.filter,
                cursor: state.filterCursor,
                width: Math.max(1, width - 8),
                color: colorFor("primary", capabilities),
            }))
            : null, state.status === null
        ? null
        : h(Text, colorProps(colorFor(state.status.isError ? "tertiary" : "success", capabilities)), state.status.text), state.status !== null && !props.busy
        ? null
        : h(Text, colorProps(colorFor("dim", capabilities)), props.busy ? "Saving…" : `${models.length} model(s)`), h(Text, colorProps(colorFor("secondary", capabilities)), editing
        ? "Enter confirm  ·  Esc cancel"
        : "← → column  ·  ↑ ↓ select  ·  Enter save  ·  Esc cancel"), editing
        ? null
        : h(Text, colorProps(colorFor("dim", capabilities)), "e edit · / filter · a add · r effort · Ctrl+R")));
}
function Row(props) {
    const style = rowStyle({
        role: props.focused ? "primary" : "dim",
        focused: props.focused && props.selected,
        capabilities: props.capabilities,
    });
    return h(Box, { width: props.width }, h(Text, {
        ...colorProps(style.color),
        ...(style.backgroundColor === undefined ? {} : { backgroundColor: style.backgroundColor }),
        ...(style.bold ? { bold: true } : {}),
        ...(style.inverse ? { inverse: true } : {}),
    }, clipText(`${props.focused && props.selected ? "▸" : " "} ${props.selected ? "●" : "○"} ${props.text}`, props.width)));
}
function translateKey(input, key) {
    if (key.ctrl === true && input === "z")
        return "undo";
    if (key.ctrl === true && input === "u")
        return "clear";
    if (key.home === true)
        return "home";
    if (key.end === true)
        return "end";
    if (key.leftArrow === true)
        return "left";
    if (key.rightArrow === true)
        return "right";
    if (key.upArrow === true)
        return "up";
    if (key.downArrow === true)
        return "down";
    if (key.tab === true)
        return "tab";
    if (key.return === true)
        return "enter";
    if (key.escape === true)
        return "escape";
    if (key.backspace === true)
        return "backspace";
    if (key.delete === true)
        return "delete";
    if (input.length > 0 && !key.ctrl && !key.meta)
        return { kind: "text", value: input };
    return null;
}
export { BROWSER_LIMITS };
