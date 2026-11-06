import { Box, type DOMElement, measureElement, Text, useBoxMetrics, useCursor } from "ink";
import { createElement as h, type ReactElement, useLayoutEffect, useRef, useState } from "react";
import { cellWidth, colorProps } from "./chrome.ts";
import { characters } from "./text-edit.ts";

/** Keep the insertion point visible; sensitive input never reaches display text. */
export function inputWindow(value: string, cursor: number, width: number, sensitive = false) {
  const parts = characters(value).map((part) => (sensitive ? "*" : part));
  const at = Math.max(0, Math.min(cursor, parts.length));
  const limit = Math.max(1, width);
  const caret = parts[at] ?? " ";
  let remaining = Math.max(0, limit - cellWidth(caret));
  let before = "";
  for (let index = at - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? "";
    if (cellWidth(part) > remaining) break;
    before = part + before;
    remaining -= cellWidth(part);
  }
  let after = "";
  for (let index = at + 1; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (cellWidth(part) > remaining) break;
    after += part;
    remaining -= cellWidth(part);
  }
  return { before, caret, after };
}

export function TextInput(props: {
  value: string;
  cursor: number;
  width: number;
  color?: string | undefined;
  sensitive?: boolean;
}): ReactElement {
  const visible = inputWindow(props.value, props.cursor, props.width, props.sensitive);
  return h(
    Box,
    { width: props.width, height: 1, flexShrink: 0 },
    h(Text, colorProps(props.color), visible.before),
    h(Caret, { text: visible.caret, color: props.color }),
    h(Text, colorProps(props.color), visible.after),
  );
}

/** Ink owns cursor escape sequences, including cleanup and IME placement. */
function Caret(props: { text: string; color: string | undefined }): ReactElement {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>();
  const { setCursorPosition } = useCursor();
  setCursorPosition(position);
  useLayoutEffect(() => {
    if (!ref.current || !metrics.hasMeasured) return;
    const { x, y } = measureElement(ref.current);
    setPosition((previous) => (previous?.x === x && previous.y === y ? previous : { x, y }));
  });
  return h(
    Box,
    { ref, width: cellWidth(props.text), height: 1, flexShrink: 0 },
    h(Text, { inverse: true, ...colorProps(props.color) }, props.text),
  );
}
