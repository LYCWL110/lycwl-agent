import { Box, Text, useInput } from "ink";
import { createElement as h, type ReactElement, useState } from "react";

import type { MemoryEntry } from "../domain/memory/memory.ts";
import { clipText, colorProps, type Viewport } from "./chrome.ts";
import { type Capabilities, colorFor } from "./palette.ts";

/**
 * Read and forget user-authored memory.
 *
 * There is no edit field here on purpose: a correction is an explicit
 * `/remember --replace <id> <text>` command, so the panel cannot silently rewrite
 * a saved rule while the user is browsing it.
 */
export function MemoryPanel(props: {
  viewport: Viewport;
  capabilities: Capabilities;
  entries: readonly MemoryEntry[] | null;
  error: string | null;
  busy: boolean;
  onDelete: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);
  const width = Math.max(1, props.viewport.columns - 4);
  const rows = Math.max(1, props.viewport.rows - 8);
  const entries = props.entries ?? [];
  const safeSelected = Math.min(selected, Math.max(0, entries.length - 1));
  const start = Math.max(0, Math.min(safeSelected - Math.floor(rows / 2), entries.length - rows));

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
      return;
    }
    if (key.upArrow) {
      setSelected(
        (value) => (value - 1 + Math.max(1, entries.length)) % Math.max(1, entries.length),
      );
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value + 1) % Math.max(1, entries.length));
      return;
    }
    if ((input === "d" || key.delete) && entries[safeSelected] !== undefined) {
      props.onDelete(entries[safeSelected].id);
    }
  });

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
      `Memory${props.busy ? " · working" : ""}`,
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      ...(props.error !== null
        ? [
            h(
              Text,
              { key: "error", ...colorProps(colorFor("tertiary", props.capabilities)) },
              props.error,
            ),
          ]
        : entries.length === 0
          ? [
              h(
                Text,
                { key: "empty", ...colorProps(colorFor("faint", props.capabilities)) },
                "no saved memory",
              ),
            ]
          : entries.slice(start, start + rows).map((entry, index) => {
              const actual = start + index;
              return h(
                Text,
                {
                  key: entry.id,
                  inverse: actual === safeSelected,
                  ...(actual === safeSelected
                    ? colorProps(colorFor("primary", props.capabilities))
                    : {}),
                },
                clipText(
                  `${actual === safeSelected ? ">" : " "} ${entry.id.slice(0, 8)} ${entry.type}/${entry.scope}  ${entry.content.replace(/\s+/gu, " ")}`,
                  width,
                ),
              );
            })),
    ),
    h(
      Text,
      colorProps(colorFor("faint", props.capabilities)),
      clipText("d forget · /remember --replace <id> <text> corrects · Esc close", width),
    ),
  );
}
