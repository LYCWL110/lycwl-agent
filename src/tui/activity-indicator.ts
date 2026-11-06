import { Box, Text, useAnimation } from "ink";
import { createElement as h, type ReactElement } from "react";
import { clipText, colorProps } from "./chrome.ts";
import { type Capabilities, colorFor } from "./palette.ts";
import type { RunActivity } from "./view-model.ts";

/** A fixed nine-cell scanner; its animation subscription exists only while busy. */
export function ActivityIndicator(props: {
  activity: RunActivity;
  capabilities: Capabilities;
  width: number;
  animated?: boolean | undefined;
}): ReactElement {
  const { frame } = useAnimation({ interval: 80, isActive: props.animated !== false });
  const step = frame % 16;
  const head = step < 9 ? step : 16 - step;
  return h(
    Box,
    { height: 1, flexShrink: 0 },
    h(
      Box,
      { width: 9, height: 1, flexShrink: 0 },
      ...Array.from({ length: 9 }, (_, index) =>
        h(
          Text,
          {
            key: index,
            bold: Math.abs(index - head) < 2,
            ...colorProps(
              colorFor(Math.abs(index - head) < 2 ? "primary" : "faint", props.capabilities),
            ),
          },
          Math.abs(index - head) < 2 ? "\u25aa" : "\u00b7",
        ),
      ),
    ),
    h(
      Text,
      colorProps(colorFor("dim", props.capabilities)),
      clipText(
        ` ${props.activity === "thinking" ? "Thinking" : "Working"}`,
        Math.max(1, props.width - 9),
      ),
    ),
  );
}
