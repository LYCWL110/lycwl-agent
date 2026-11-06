import { Box, Text, useInput } from "ink";
import { createElement as h, type ReactElement } from "react";
import { ConfigChrome, clipText, colorProps, useViewport, type Viewport } from "./chrome.ts";
import {
  applyKey,
  BROWSER_LIMITS,
  type BrowserKey,
  type BrowserState,
  filteredModels,
  visibleWindow,
} from "./config-browser.ts";
import { type Capabilities, colorFor, rowStyle } from "./palette.ts";
import { TextInput } from "./text-input.ts";

export type ConfigBrowserProps = Readonly<{
  state: BrowserState;
  capabilities: Capabilities;
  endpoint?: string;
  busy?: boolean;
  animated?: boolean;
  viewport?: Viewport;
  onState: (state: BrowserState) => void;
  onCommit: (value: Readonly<{ protocol: string; model: string }>) => void;
  onCancel: () => void;
  onEdit?: () => void;
  onRefresh?: () => void;
}>;

/** Shared Miyu chrome, independent column focus and a separate selection marker. */
export function ConfigBrowser(props: ConfigBrowserProps): ReactElement {
  const { state, capabilities } = props;
  const viewport = useViewport(props.viewport);
  const width = Math.max(1, Math.min(84, viewport.columns - 4));
  const stacked = width < 62;
  const providerWidth = stacked ? width : Math.floor(width * 0.25);
  const protocolWidth = stacked ? width : Math.floor(width * 0.34);
  const modelWidth = stacked ? width : width - providerWidth - protocolWidth - 2;
  const editing = state.filterMode || state.modelInput !== null;

  useInput((input, key) => {
    if (props.busy) return;
    if (!editing && input === "e" && !key.ctrl && !key.meta) {
      props.onEdit?.();
      return;
    }
    if (!editing && key.ctrl && input === "r") {
      props.onRefresh?.();
      return;
    }
    const translated = translateKey(input, key);
    if (translated === null) return;
    const outcome = applyKey(state, translated);
    if (outcome.cancel) props.onCancel();
    else if (outcome.commit !== null) props.onCommit(outcome.commit);
    else if (outcome.state !== state) props.onState(outcome.state);
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
  ];
  return h(
    ConfigChrome,
    { capabilities, viewport, title: "Provider / Model", animated: props.animated },
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Provider configuration"),
      props.endpoint === undefined
        ? null
        : h(Text, colorProps(colorFor("dim", capabilities)), clipText(props.endpoint, width)),
      h(
        Box,
        { flexDirection: stacked ? "column" : "row", marginTop: 1, gap: 1 },
        ...columns
          .filter((column) => !stacked || column.focused)
          .map((column) =>
            h(
              Box,
              {
                key: column.title,
                width: column.width,
                flexDirection: "column",
                minHeight: stacked ? undefined : BROWSER_LIMITS.visibleRows + 2,
              },
              h(
                Text,
                {
                  bold: true,
                  ...colorProps(colorFor(column.focused ? "secondary" : "dim", capabilities)),
                },
                clipText(column.title, column.width),
              ),
              h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(column.width)),
              ...visibleWindow(column.values, column.offset).map((value, index) => {
                return h(
                  Row,
                  // biome-ignore lint/correctness/useJsxKeyInIterable: The React createElement props below include a stable key.
                  {
                    key: `${column.title}-${value}`,
                    text: value,
                    width: column.width,
                    focused: column.focused,
                    selected: column.offset + index === column.selected,
                    capabilities,
                  },
                );
              }),
              column.values.length === 0
                ? h(Text, colorProps(colorFor("dim", capabilities)), "(no models)")
                : null,
            ),
          ),
      ),
      h(Text, colorProps(colorFor("faint", capabilities)), "─".repeat(width)),
      state.modelInput !== null
        ? h(
            Box,
            null,
            h(Text, colorProps(colorFor("primary", capabilities)), "Model id: "),
            h(TextInput, {
              value: state.modelInput,
              cursor: state.modelCursor,
              width: Math.max(1, width - 10),
              color: colorFor("primary", capabilities),
            }),
          )
        : state.filterMode
          ? h(
              Box,
              null,
              h(Text, colorProps(colorFor("primary", capabilities)), "Filter: "),
              h(TextInput, {
                value: state.filter,
                cursor: state.filterCursor,
                width: Math.max(1, width - 8),
                color: colorFor("primary", capabilities),
              }),
            )
          : null,
      state.status === null
        ? null
        : h(
            Text,
            colorProps(colorFor(state.status.isError ? "tertiary" : "success", capabilities)),
            state.status.text,
          ),
      h(
        Text,
        colorProps(colorFor("dim", capabilities)),
        props.busy ? "Saving…" : `${models.length} model(s)`,
      ),
      h(
        Text,
        colorProps(colorFor("secondary", capabilities)),
        editing
          ? "Enter confirm  ·  Esc cancel"
          : "← → column  ·  ↑ ↓ select  ·  Enter save  ·  Esc cancel",
      ),
      editing
        ? null
        : h(
            Text,
            colorProps(colorFor("dim", capabilities)),
            "e edit endpoint/key  ·  / filter  ·  a add model  ·  Ctrl+R refresh",
          ),
    ),
  );
}

function Row(props: {
  text: string;
  width: number;
  focused: boolean;
  selected: boolean;
  capabilities: Capabilities;
}): ReactElement {
  const style = rowStyle({
    role: props.focused ? "primary" : "dim",
    focused: props.focused && props.selected,
    capabilities: props.capabilities,
  });
  return h(
    Box,
    { width: props.width },
    h(
      Text,
      {
        ...colorProps(style.color),
        ...(style.backgroundColor === undefined ? {} : { backgroundColor: style.backgroundColor }),
        ...(style.bold ? { bold: true } : {}),
        ...(style.inverse ? { inverse: true } : {}),
      },
      clipText(
        `${props.focused && props.selected ? "▸" : " "} ${props.selected ? "●" : "○"} ${props.text}`,
        props.width,
      ),
    ),
  );
}

function translateKey(
  input: string,
  key: {
    leftArrow?: boolean;
    rightArrow?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    tab?: boolean;
    return?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    home?: boolean;
    end?: boolean;
  },
): BrowserKey | null {
  if (key.ctrl === true && input === "z") return "undo";
  if (key.ctrl === true && input === "u") return "clear";
  if (key.home === true) return "home";
  if (key.end === true) return "end";
  if (key.leftArrow === true) return "left";
  if (key.rightArrow === true) return "right";
  if (key.upArrow === true) return "up";
  if (key.downArrow === true) return "down";
  if (key.tab === true) return "tab";
  if (key.return === true) return "enter";
  if (key.escape === true) return "escape";
  if (key.backspace === true) return "backspace";
  if (key.delete === true) return "delete";
  if (input.length > 0 && !key.ctrl && !key.meta) return { kind: "text", value: input };
  return null;
}

export { BROWSER_LIMITS };
