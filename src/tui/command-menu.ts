import { Box, Text } from "ink";
import { createElement as h, type ReactElement } from "react";
import { cellWidth, clipText, colorProps } from "./chrome.ts";
import { type Capabilities, colorFor } from "./palette.ts";

export function CommandMenu(props: {
  commands: readonly Readonly<{ name: string; description: string }>[];
  selected: number;
  enabled: boolean;
  width: number;
  capabilities: Capabilities;
}): ReactElement | null {
  if (props.commands.length === 0) return null;
  const { capabilities, width } = props;
  const innerWidth = Math.max(1, width - 2);
  const nameWidth = Math.min(
    Math.max(...props.commands.map((command) => cellWidth(command.name))) + 2,
    Math.max(1, Math.floor(innerWidth / 2)),
  );
  return h(
    Box,
    {
      position: "absolute",
      bottom: 2,
      left: 0,
      width,
      height: props.commands.length,
      flexDirection: "column",
      backgroundColor: capabilities.depth === "mono" ? undefined : "#202020",
    },
    ...props.commands.map((command, index) => {
      const selected = index === props.selected;
      const highlight = selected && capabilities.depth !== "mono";
      const foreground = highlight ? "black" : colorFor("dim", capabilities);
      const description = clipText(
        props.enabled ? command.description : `${command.description} (idle only)`,
        Math.max(1, innerWidth - nameWidth),
      );
      return h(
        Box,
        {
          key: command.name,
          width,
          height: 1,
          flexShrink: 0,
          paddingX: 1,
          backgroundColor: highlight ? colorFor("secondary", capabilities) : undefined,
        },
        h(
          Text,
          {
            inverse: selected && capabilities.depth === "mono",
            ...colorProps(foreground),
          },
          clipText(command.name, nameWidth).padEnd(nameWidth),
          description,
          " ".repeat(Math.max(0, innerWidth - nameWidth - cellWidth(description))),
        ),
      );
    }),
  );
}
