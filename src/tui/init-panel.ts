import { Box, Text, useInput } from "ink";
import { createElement as h, type ReactElement } from "react";
import { clipText, colorProps, type Viewport, wrapText } from "./chrome.ts";
import { type Capabilities, colorFor } from "./palette.ts";

/**
 * AGENTS.md creation confirmation.
 *
 * `/init` generates a draft from a shallow project scan and writes it. Every other
 * file mutation in this Harness is previewed and approved, and this was the single
 * exception: it wrote straight from the entry point, so a keystroke in the composer
 * created a file with no preview and no consent.
 *
 * The panel shows the target, the size, what the scan detected and the first lines
 * of the draft. The head is enough to recognise a wrong scan; the whole draft is
 * available after it is written, and writing it is what the user is deciding.
 */

export type InitPreview = Readonly<{
  path: string;
  bytes: number;
  detected: readonly string[];
  head: string;
}>;

export function InitPanel(props: {
  viewport: Viewport;
  capabilities: Capabilities;
  preview: InitPreview;
  busy: boolean;
  notice: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const width = Math.max(1, props.viewport.columns - 4);
  const rows = Math.max(1, props.viewport.rows - 8);

  useInput((input, key) => {
    if (props.busy) return;
    if (key.escape || input === "n" || input === "N") {
      props.onCancel();
      return;
    }
    if (key.return || input === "y" || input === "Y") props.onConfirm();
  });

  const headLines = props.preview.head
    .split("\n")
    .slice(0, rows)
    .flatMap((line) => wrapText(line, width));

  return h(
    Box,
    {
      width: props.viewport.columns,
      height: Math.max(1, props.viewport.rows - 1),
      flexDirection: "column",
      paddingX: 2,
      overflow: "hidden",
    },
    h(
      Text,
      { bold: true, ...colorProps(colorFor("primary", props.capabilities)) },
      "Create AGENTS.md",
    ),
    h(
      Text,
      colorProps(colorFor("dim", props.capabilities)),
      clipText(`path: ${props.preview.path}`, width),
    ),
    h(
      Text,
      colorProps(colorFor("dim", props.capabilities)),
      clipText(
        `bytes: ${props.preview.bytes}   detected: ${
          props.preview.detected.length === 0 ? "unknown stack" : props.preview.detected.join(", ")
        }`,
        width,
      ),
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, overflow: "hidden", marginTop: 1 },
      ...headLines.map((line, index) =>
        h(Text, { key: index, ...colorProps(colorFor("faint", props.capabilities)) }, line),
      ),
    ),
    h(
      Text,
      colorProps(colorFor("tertiary", props.capabilities)),
      clipText(props.notice ?? "", width),
    ),
    h(
      Text,
      colorProps(colorFor("dim", props.capabilities)),
      clipText("Enter / y create   Esc / n cancel", width),
    ),
  );
}
