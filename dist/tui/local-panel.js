import { Box, Text, useInput, usePaste } from "ink";
import { createElement as h, useState } from "react";
import { clipText, colorProps, wrapText } from "./chrome.js";
import { colorFor } from "./palette.js";
import { editText } from "./text-edit.js";
import { TextInput } from "./text-input.js";
import { COMPOSER_COMMANDS } from "./view-model.js";
export function LocalPanel(props) {
    const [selected, setSelected] = useState(0);
    const [resume, setResume] = useState(null);
    const [offset, setOffset] = useState(0);
    const width = Math.max(1, props.viewport.columns - 4);
    const rows = Math.max(1, props.viewport.rows - 6);
    const helpLines = [
        ...COMPOSER_COMMANDS.map((command) => `${command.name}  ${command.description}`),
        "/session new  Start a fresh session",
        "/session resume <id>  Resume recorded context",
        "Click tool row / Ctrl+T  Toggle tool details",
    ].flatMap((text) => wrapText(text, width));
    useInput((input, key) => {
        if (key.escape) {
            if (resume !== null)
                setResume(null);
            else
                props.onClose();
            return;
        }
        if (key.ctrl && input === "c") {
            props.onSubmit("/cancel");
            return;
        }
        if (props.kind === "skills") {
            if (key.return)
                props.onClose();
            return;
        }
        if (props.kind === "help") {
            if (key.return)
                props.onClose();
            if (key.downArrow || key.pageDown)
                setOffset((value) => Math.min(Math.max(0, helpLines.length - rows), value + 1));
            if (key.upArrow || key.pageUp)
                setOffset((value) => Math.max(0, value - 1));
            return;
        }
        if (resume !== null) {
            if (key.return) {
                if (resume.value.trim())
                    props.onSubmit(`/session resume ${resume.value.trim()}`);
            }
            else {
                const edited = editText(resume, input, key);
                if (edited.value.length <= 80)
                    setResume(edited);
            }
            return;
        }
        if (key.upArrow || key.downArrow)
            setSelected((value) => (value + (key.upArrow ? 2 : 1)) % 3);
        if (key.return) {
            if (selected === 0)
                props.onClose();
            if (selected === 1)
                props.onSubmit("/new");
            if (selected === 2)
                setResume({ value: "", cursor: 0 });
        }
    });
    usePaste((text) => {
        if (resume === null)
            return;
        const edited = editText(resume, text, {});
        if (edited.value.length <= 80)
            setResume(edited);
    });
    return h(Box, {
        width: props.viewport.columns,
        height: Math.max(1, props.viewport.rows - 1),
        flexDirection: "column",
        paddingX: 2,
        overflow: "hidden",
    }, h(Text, { bold: true, ...colorProps(colorFor("primary", props.capabilities)) }, props.kind === "help" ? "Commands" : props.kind === "skills" ? "Skills" : "Session"), h(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden" }, ...(props.kind === "skills"
        ? renderSkillLines(props, width)
        : props.kind === "help"
            ? helpLines
                .slice(offset, offset + rows)
                .map((line, index) => h(Text, { key: index }, line))
            : [
                h(Text, { key: "id", wrap: "wrap", ...colorProps(colorFor("dim", props.capabilities)) }, `Current: ${props.sessionId ?? "unavailable"}`),
                ...["Keep current session", "New session", "Resume by ID"].map((label, index) => h(Text, {
                    key: label,
                    inverse: selected === index && resume === null,
                }, clipText(`${selected === index ? ">" : " "} ${label}`, width))),
                resume === null
                    ? null
                    : h(Box, { key: "input" }, h(Text, null, "ID: "), h(TextInput, { ...resume, width: Math.max(1, width - 4) })),
            ])), h(Text, colorProps(colorFor("tertiary", props.capabilities)), clipText(props.notice ?? "", width)), h(Text, colorProps(colorFor("dim", props.capabilities)), clipText(props.kind === "help" ? "Enter / Esc close" : "Enter select  Esc back", width)));
}
/**
 * Skill catalog lines.
 *
 * A failure is shown as its reason rather than as an empty list: an empty list would
 * claim the workspace has no skills, which is a different fact.
 */
function renderSkillLines(props, width) {
    if (props.skillCatalogError !== null && props.skillCatalogError !== undefined) {
        return [
            h(Text, { key: "err", ...colorProps(colorFor("tertiary", props.capabilities)) }, clipText(`unavailable: ${props.skillCatalogError}`, width)),
        ];
    }
    const catalog = props.skillCatalog ?? [];
    if (catalog.length === 0) {
        return [
            h(Text, { key: "none", ...colorProps(colorFor("faint", props.capabilities)) }, clipText("no skills in .agents/skills", width)),
        ];
    }
    return catalog.flatMap((entry) => [
        h(Text, { key: entry.skillId, bold: true, ...colorProps(colorFor("primary", props.capabilities)) }, clipText(entry.skillId, width)),
        h(Text, { key: `${entry.skillId}-d`, ...colorProps(colorFor("dim", props.capabilities)) }, clipText(`  ${entry.description}`, width)),
    ]);
}
