/**
 * Terminal palette and capability detection.
 *
 * Borrowed in structure from the Miyu reference (`crates/miyu-base/src/terminal/
 * palette.rs`): a design palette declared once in RGB, degraded at render time
 * according to what the terminal can actually show. The reference's point is worth
 * keeping — a downgrade is not "fewer colours", it is a different means of expressing
 * the same distinction, so a selected row becomes reverse video instead of a
 * background colour when only 16 colours exist.
 *
 * This module is pure: it reads no environment. The caller passes the detected
 * capabilities, so a test can exercise every depth without touching the process.
 */

export type ColorDepth = "truecolor" | "xterm256" | "ansi16" | "mono";

/** The selected palette, in RGB. Named by role, not by hue, so a retheme is local. */
export const PALETTE = Object.freeze({
  /** Primary: cool blue, used for the focused element. */
  primary: [0xae, 0xbd, 0xe8] as const,
  /** Secondary: warm gold, used for headings. */
  secondary: [0xe4, 0xbf, 0x79] as const,
  /** Tertiary: muted red, used for destructive and error states. */
  tertiary: [0xe3, 0x8c, 0x9a] as const,
  /** Success. */
  success: [0x9c, 0xcf, 0xa0] as const,
  /** Dimmed text. */
  dim: [0x99, 0x93, 0xa5] as const,
  /** Faint text: hints. */
  faint: [0x6b, 0x66, 0x77] as const,
});

export type PaletteRole = keyof typeof PALETTE;

export type Capabilities = Readonly<{
  depth: ColorDepth;
  /** True when the terminal can render bold. */
  bold: boolean;
  /** True when the terminal can render reverse video. */
  reverse: boolean;
  /** True when the terminal width is unknown or very small. */
  narrow: boolean;
}>;

/**
 * Detect capabilities from environment values the caller supplies.
 *
 * `NO_COLOR` wins over everything, matching the cross-tool convention. The order
 * matters: a user who set `NO_COLOR` did so deliberately.
 */
export function detectCapabilities(input: {
  noColor: boolean;
  colorterm: string | undefined;
  term: string | undefined;
  force: string | undefined;
}): Capabilities {
  const depth = detectDepth(input);
  return {
    depth,
    // Bold and reverse are baseline terminal features; a monochrome terminal still
    // has them, which is why the downgrade can stay legible.
    bold: true,
    reverse: true,
    narrow: false,
  };
}

function detectDepth(input: {
  noColor: boolean;
  colorterm: string | undefined;
  term: string | undefined;
  force: string | undefined;
}): ColorDepth {
  if (input.noColor) return "mono";
  const forced = input.force?.trim().toLowerCase();
  if (forced !== undefined) {
    if (forced === "truecolor" || forced === "24bit" || forced === "true") return "truecolor";
    if (forced === "256" || forced === "xterm256") return "xterm256";
    if (forced === "16" || forced === "ansi") return "ansi16";
    if (forced === "none" || forced === "mono" || forced === "0") return "mono";
  }
  const colorterm = input.colorterm?.toLowerCase() ?? "";
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = input.term?.toLowerCase() ?? "";
  if (term.length === 0 || term === "dumb") return "mono";
  if (term.includes("kitty") || term.includes("wezterm") || term.includes("alacritty")) {
    return "truecolor";
  }
  if (term.includes("256color") || term.includes("direct")) return "xterm256";
  return "ansi16";
}

/**
 * A colour as Ink accepts it: a hex string or a named ANSI colour. Ink does not
 * accept a bare numeric index, so the 256-colour table uses names that map to the
 * nearest basic colour rather than an index.
 */
export type InkColor = string | undefined;

const ANSI16: Readonly<Record<PaletteRole, string>> = {
  primary: "cyan",
  secondary: "yellow",
  tertiary: "red",
  success: "green",
  dim: "gray",
  faint: "gray",
};

/**
 * At 256 colours Ink still only accepts named or hex values, so the palette uses hex
 * here too. The distinction from truecolor is that a caller may choose to flatten
 * the palette; this module keeps the mapping explicit rather than pretending a
 * numeric index is a colour.
 */
const X256: Readonly<Record<PaletteRole, string>> = {
  primary: "#87afd7",
  secondary: "#d7af5f",
  tertiary: "#d78787",
  success: "#87af87",
  dim: "#878787",
  faint: "#878787",
};

/** Map a palette role to something the renderer can use at the given depth. */
export function colorFor(role: PaletteRole, capabilities: Capabilities): InkColor {
  if (capabilities.depth === "mono") return undefined;
  if (capabilities.depth === "ansi16") return ANSI16[role];
  if (capabilities.depth === "xterm256") return X256[role];
  const [r, g, b] = PALETTE[role];
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * Whether a gradient is worth drawing.
 *
 * Below 256 colours a gradient becomes a series of jumping blocks, which reads worse
 * than a single colour. The reference makes the same call.
 */
export function gradientWorthDrawing(capabilities: Capabilities): boolean {
  return capabilities.depth === "truecolor" || capabilities.depth === "xterm256";
}

export type RowStyle = Readonly<{
  color: InkColor;
  bold: boolean;
  /** Reverse video is how selection is expressed without a background colour. */
  inverse: boolean;
}>;

/**
 * Style for a row, given whether it is focused.
 *
 * At 16 colours or below, focus is shown by reverse video rather than a colour, so
 * the distinction survives on a terminal that cannot show a highlight.
 */
export function rowStyle(input: {
  role: PaletteRole;
  focused: boolean;
  capabilities: Capabilities;
}): RowStyle {
  const color = colorFor(input.role, input.capabilities);
  const lowColor = input.capabilities.depth === "ansi16" || input.capabilities.depth === "mono";
  return {
    color,
    bold: input.focused && input.capabilities.bold,
    inverse: input.focused && lowColor && input.capabilities.reverse,
  };
}
