import { Box, Text, useInput } from "ink";
import { createElement, useState } from "react";
import { maskSecret, protocolReasoningEfforts, SUPPORTED_PROTOCOLS, } from "../domain/config/provider-config.js";
import { ConfigChrome, clipText, colorProps, useViewport } from "./chrome.js";
import { colorFor, detectCapabilities, rowStyle } from "./palette.js";
import { characters, editText } from "./text-edit.js";
import { TextInput } from "./text-input.js";
/**
 * First-time setup screen (S02 "初次设置").
 *
 * Rules this screen follows:
 * - the key input never echoes, and the stored key is never displayed;
 * - save and discard are separate, explicit actions;
 * - a validation error is shown against the field, and the draft is kept;
 * - this screen performs no I/O. It reports a draft upward; the caller decides
 *   whether to write it.
 */
const h = createElement;
const FIELD_ORDER = [
    "baseUrl",
    "protocol",
    "apiKey",
    "model",
    "reasoningEffort",
    "contextWindow",
    "maxOutputTokens",
    "credentialRef",
];
const FIELD_LABEL = {
    protocol: "Protocol",
    baseUrl: "Base URL",
    model: "Model",
    credentialRef: "Credential reference",
    apiKey: "API key",
    reasoningEffort: "Reasoning",
    contextWindow: "Context tokens",
    maxOutputTokens: "Output tokens",
};
const PROTOCOL_LABEL = {
    anthropic_messages: "Anthropic",
    openai_chat: "OpenAI Chat",
    openai_responses: "Responses",
};
export function SetupScreen(props) {
    const [draft, setDraft] = useState({
        protocol: props.initial.protocol ?? "anthropic_messages",
        baseUrl: props.initial.baseUrl ?? "https://api.anthropic.com",
        model: props.initial.model ?? "",
        apiKey: props.initial.apiKey ?? "",
        credentialRef: props.initial.credentialRef ?? "provider-main",
        reasoningEffort: props.initial.reasoningEffort ?? "default",
        contextWindow: props.initial.contextWindow == null ? "" : String(props.initial.contextWindow),
        maxOutputTokens: String(props.initial.maxOutputTokens ?? 4096),
    });
    const actions = [...FIELD_ORDER, ...(props.onBrowse ? ["models"] : []), "save", "discard"];
    const [focus, setFocus] = useState(props.hasStoredCredential ? "baseUrl" : "protocol");
    const [editing, setEditing] = useState(false);
    const [cursors, setCursors] = useState({
        protocol: 0,
        baseUrl: characters(props.initial.baseUrl ?? "https://api.anthropic.com").length,
        model: characters(props.initial.model ?? "").length,
        credentialRef: characters(props.initial.credentialRef ?? "provider-main").length,
        apiKey: characters(props.initial.apiKey ?? "").length,
        reasoningEffort: 0,
        contextWindow: String(props.initial.contextWindow ?? "").length,
        maxOutputTokens: String(props.initial.maxOutputTokens ?? 4096).length,
    });
    const viewport = useViewport(props.viewport);
    const width = Math.max(1, Math.min(84, viewport.columns - 4));
    const capabilities = props.capabilities ??
        detectCapabilities({
            noColor: process.env["NO_COLOR"] !== undefined,
            colorterm: process.env["COLORTERM"],
            term: process.env["TERM"],
            force: process.env["LYCWL_COLOR"],
            windowsTerminal: process.env["WT_SESSION"] !== undefined,
        });
    function cycleProtocol(delta) {
        setDraft((current) => {
            const index = SUPPORTED_PROTOCOLS.indexOf(current.protocol);
            const next = (index + delta + SUPPORTED_PROTOCOLS.length) % SUPPORTED_PROTOCOLS.length;
            const protocol = SUPPORTED_PROTOCOLS[next] ?? "anthropic_messages";
            return {
                ...current,
                protocol,
            };
        });
    }
    function cycleReasoning(delta) {
        if (props.onBrowse !== undefined) {
            props.onBrowse(draft, "reasoning");
            return;
        }
        setDraft((current) => {
            const efforts = protocolReasoningEfforts(current.protocol);
            const index = efforts.indexOf(current.reasoningEffort ?? "default");
            return {
                ...current,
                reasoningEffort: efforts[(index + delta + efforts.length) % efforts.length] ?? "default",
            };
        });
    }
    useInput((input, key) => {
        if (props.busy)
            return;
        if (key.escape) {
            if (editing)
                setEditing(false);
            else
                props.onDiscard();
            return;
        }
        if (key.ctrl && input === "s") {
            props.onSave(draft);
            return;
        }
        if (key.tab || key.downArrow) {
            setEditing(false);
            setFocus((current) => actions[(actions.indexOf(current) + (key.shift ? -1 : 1) + actions.length) % actions.length] ?? "baseUrl");
            return;
        }
        if (key.upArrow) {
            setEditing(false);
            setFocus((current) => actions[(actions.indexOf(current) - 1 + actions.length) % actions.length] ?? "baseUrl");
            return;
        }
        if (key.return) {
            if (focus === "save")
                props.onSave(draft);
            else if (focus === "discard")
                props.onDiscard();
            else if (focus === "models")
                props.onBrowse?.(draft);
            else if (focus === "model" && !editing && props.onBrowse)
                props.onBrowse(draft);
            else if (focus === "protocol")
                cycleProtocol(1);
            else if (focus === "reasoningEffort")
                cycleReasoning(1);
            else
                setEditing((current) => !current);
            return;
        }
        if (!editing && !key.ctrl && !key.meta && input === "s") {
            props.onSave(draft);
            return;
        }
        if (focus === "protocol") {
            if (key.leftArrow || key.rightArrow || input === " ") {
                cycleProtocol(key.leftArrow ? -1 : 1);
            }
            return;
        }
        if (focus === "reasoningEffort") {
            if (key.leftArrow || key.rightArrow || input === " ")
                cycleReasoning(key.leftArrow ? -1 : 1);
            return;
        }
        if (!editing || !FIELD_ORDER.includes(focus))
            return;
        const field = focus;
        const next = editText({ value: draft[field], cursor: cursors[field] }, input, key);
        setDraft((current) => ({ ...current, [field]: next.value }));
        setCursors((current) => ({ ...current, [field]: next.cursor }));
    });
    return h(ConfigChrome, { capabilities, viewport, title: "Provider setup", animated: props.animated }, h(Box, { flexDirection: "column" }, ...FIELD_ORDER.map((field) => h(FieldRow, {
        key: field,
        field,
        value: field === "reasoningEffort"
            ? `${draft.reasoningEffort ?? "default"}${props.onBrowse ? "" : " (manual)"}`
            : draft[field],
        focused: focus === field,
        editing: editing && focus === field,
        cursor: cursors[field],
        stored: field === "apiKey" && props.hasStoredCredential,
        required: field !== "reasoningEffort" && !(field === "apiKey" && props.hasStoredCredential),
        error: props.error !== null && props.error.field === field ? props.error.code : null,
        capabilities,
        width,
    })), h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(width)), ...actions
        .filter((action) => !FIELD_ORDER.includes(action))
        .map((action) => h(Text, {
        key: action,
        bold: focus === action,
        ...colorProps(colorFor(focus === action ? "secondary" : "dim", capabilities)),
    }, `${focus === action ? "▸" : " "} ${action === "save" ? "Save" : action === "discard" ? "Discard" : "Models / catalog"}`)), h(Text, colorProps(colorFor("dim", capabilities)), editing
        ? "Editing · ← → Home/End · Ctrl+U clear"
        : "↑ ↓ Tab select · Enter edit · ← → protocol"), h(Text, colorProps(colorFor("dim", capabilities)), editing ? "Enter finish · Ctrl+S save · Esc finish" : "s / Ctrl+S save · Esc discards"), ...props.warnings.map((warning, index) => h(Box, { key: `warn-${index}`, marginTop: index === 0 ? 1 : 0 }, h(Text, colorProps(colorFor("secondary", capabilities)), `warning: ${warning}`))), props.saveError
        ? h(Text, colorProps(colorFor("tertiary", capabilities)), `Save failed: ${props.saveError}`)
        : null, props.busy ? h(Text, colorProps(colorFor("secondary", capabilities)), "Saving…") : null));
}
function FieldRow(props) {
    const label = props.width < 60 && props.field === "credentialRef" ? "Credential" : FIELD_LABEL[props.field];
    const protocolLabel = PROTOCOL_LABEL[props.value];
    const style = rowStyle({
        role: props.focused ? "primary" : "dim",
        focused: props.focused,
        capabilities: props.capabilities,
    });
    return h(Box, { flexDirection: "column", width: props.width }, h(Box, { width: props.width }, h(Text, colorProps(style.color), props.focused ? "▸ " : "  "), h(Box, { width: props.width < 60 ? 13 : 24, flexShrink: 0 }, h(Text, { bold: props.focused }, clipText(label, props.width < 60 ? 10 : 21)), props.required ? h(Text, colorProps(colorFor("tertiary", props.capabilities)), " *") : null), props.editing
        ? h(TextInput, {
            value: props.value,
            cursor: props.cursor,
            width: Math.max(1, props.width - (props.width < 60 ? 15 : 26)),
            sensitive: props.field === "apiKey",
            color: style.color,
        })
        : h(Text, {
            ...colorProps(style.color),
            ...(style.backgroundColor === undefined
                ? {}
                : { backgroundColor: style.backgroundColor }),
            ...(style.inverse ? { inverse: true } : {}),
        }, clipText(props.field === "protocol"
            ? `‹ ${protocolLabel ?? props.value} ›`
            : props.field === "reasoningEffort"
                ? `‹ ${props.value} ›`
                : props.field === "apiKey"
                    ? props.value.length > 0
                        ? maskSecret(props.value)
                        : props.stored
                            ? "(stored)"
                            : "(empty)"
                    : props.value.length === 0
                        ? "(empty)"
                        : props.value, Math.max(1, props.width - (props.width < 60 ? 15 : 26))))), props.error === null
        ? null
        : h(Box, { marginLeft: 2 }, h(Text, { color: "red" }, `invalid: ${props.error}`)));
}
