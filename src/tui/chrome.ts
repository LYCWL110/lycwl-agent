import { Box, Text, useAnimation, useWindowSize } from "ink";
import { createElement as h, type ReactElement } from "react";
import { type Capabilities, colorFor, gradientWorthDrawing, PALETTE } from "./palette.ts";

export type Viewport = Readonly<{ columns: number; rows: number }>;

export function useViewport(override?: Viewport): Viewport {
  const window = useWindowSize();
  return override ?? { columns: window.columns || 80, rows: window.rows || 24 };
}

export function colorProps(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal cells, keeping combining sequences and emoji together when clipping. */
export function cellWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += segmentWidth(segment);
  return width;
}

function segmentWidth(segment: string): number {
  if (/^[\p{Mark}\p{Control}\p{Format}]+$/u.test(segment)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)) return 2;
  const point = segment.codePointAt(0) ?? 0;
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff01 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x20000 && point <= 0x3fffd))
    ? 2
    : 1;
}

export function clipText(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (cellWidth(text) <= columns) return text;
  let output = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const width = segmentWidth(segment);
    if (used + width > columns - 1) break;
    output += segment;
    used += width;
  }
  return `${output}…`;
}

export function wrapText(text: string, columns: number): string[] {
  const limit = Math.max(2, columns);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    let used = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const width = segmentWidth(segment);
      if (used + width > limit) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += segment;
      used += width;
    }
    lines.push(line);
  }
  return lines;
}

const ART = [
  "██╗     ██╗   ██╗ ██████╗██╗    ██╗██╗     ",
  "██║     ╚██╗ ██╔╝██╔════╝██║    ██║██║     ",
  "██║      ╚████╔╝ ██║     ██║ █╗ ██║██║     ",
  "██║       ╚██╔╝  ██║     ██║███╗██║██║     ",
  "███████╗   ██║   ╚██████╗╚███╔███╔╝███████╗",
  "╚══════╝   ╚═╝    ╚═════╝ ╚══╝╚══╝ ╚══════╝",
];

function gradientColor(position: number, capabilities: Capabilities, lift = 0): string | undefined {
  if (!gradientWorthDrawing(capabilities)) return colorFor("primary", capabilities);
  const from = PALETTE.primary;
  const to = PALETTE.tertiary;
  const rgb = from.map((value, index) => {
    const mixed = value + ((to[index] ?? value) - value) * position;
    return Math.round(mixed + (255 - mixed) * lift)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${rgb.join("")}`;
}

/** Miyu's shared banner/caption composition, with this project's own wordmark. */
export function Brand(props: {
  capabilities: Capabilities;
  width: number;
  compact?: boolean;
  animated?: boolean | undefined;
}): ReactElement {
  const { capabilities, width } = props;
  const compact = props.compact === true || width < 46;
  const { frame } = useAnimation({
    interval: 80,
    isActive: props.animated === true && !compact && gradientWorthDrawing(capabilities),
  });
  const artWidth = ART[0]?.length ?? 42;
  const glint = ((frame * 0.9) % (artWidth + 35)) - 6;
  const sideWidth = Math.max(0, Math.floor((width - artWidth - 2) / 2));
  const stars = (row: number, side: number): string =>
    Array.from({ length: sideWidth }, (_, column) =>
      (column * 13 + row * 17 + side * 11) % 47 === 0
        ? [".", "+", "✦", "."][Math.floor(frame / 8 + column) % 4]
        : " ",
    ).join("");
  return h(
    Box,
    { flexDirection: "column", alignItems: "center", width },
    ...(compact
      ? [
          h(
            Text,
            { key: "name", bold: true, ...colorProps(colorFor("primary", capabilities)) },
            "lycwl",
          ),
        ]
      : ART.map((row, index) =>
          h(
            Box,
            { key: index },
            h(Text, colorProps(colorFor("faint", capabilities)), `${stars(index, 0)} `),
            h(
              Text,
              null,
              ...[...row].map((character, column) =>
                h(
                  Text,
                  {
                    key: column,
                    ...colorProps(
                      gradientColor(
                        column / (row.length - 1),
                        capabilities,
                        props.animated ? Math.max(0, 1 - Math.abs(column - glint) / 4) * 0.7 : 0,
                      ),
                    ),
                  },
                  character,
                ),
              ),
            ),
            h(Text, colorProps(colorFor("faint", capabilities)), ` ${stars(index, 1)}`),
          ),
        )),
    h(Text, colorProps(colorFor("dim", capabilities)), "─  A G E N T  ─"),
  );
}

export function ConfigChrome(props: {
  capabilities: Capabilities;
  viewport?: Viewport;
  title: string;
  animated?: boolean | undefined;
  children?: ReactElement | readonly ReactElement[];
}): ReactElement {
  const viewport = useViewport(props.viewport);
  const width = Math.max(1, Math.min(84, viewport.columns - 4));
  return h(
    Box,
    {
      width: viewport.columns,
      minHeight: Math.max(1, viewport.rows - 1),
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      paddingY: viewport.rows < 30 ? 0 : 1,
    },
    h(Brand, {
      capabilities: props.capabilities,
      width,
      compact: viewport.rows < 34,
      animated: props.animated,
    }),
    h(
      Box,
      { width, flexDirection: "column", marginTop: 1 },
      h(
        Text,
        { bold: true, ...colorProps(colorFor("secondary", props.capabilities)) },
        clipText(`● Settings  ──  ◉ ${props.title}`, width),
      ),
      h(Text, colorProps(colorFor("faint", props.capabilities)), "─".repeat(width)),
      props.children,
    ),
  );
}
