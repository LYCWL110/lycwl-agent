import { Box, Text, useInput } from "ink";
import { createElement, type ReactElement } from "react";

import {
  applyKey,
  BROWSER_LIMITS,
  type BrowserKey,
  type BrowserState,
  filteredModels,
  visibleWindow,
} from "./config-browser.ts";
import { type Capabilities, colorFor, rowStyle } from "./palette.ts";

/**
 * Three-column provider browser.
 *
 * Layout follows the Miyu reference: provider, protocol and model side by side, with
 * the focused column marked and a status line that distinguishes information from
 * error by colour. Rendering is pure; every key is forwarded to the reducer, which
 * owns all the rules.
 */

const h = createElement;

export type ConfigBrowserProps = Readonly<{
  state: BrowserState;
  capabilities: Capabilities;
  onState: (state: BrowserState) => void;
  onCommit: (value: Readonly<{ protocol: string; model: string }>) => void;
  onCancel: () => void;
}>;

export function ConfigBrowser(props: ConfigBrowserProps): ReactElement {
  const { state, capabilities } = props;

  useInput((input, key) => {
    const translated = translateKey(input, key);
    if (translated === null) return;
    const outcome = applyKey(state, translated);
    if (outcome.cancel) {
      props.onCancel();
      return;
    }
    if (outcome.commit !== null) {
      props.onCommit(outcome.commit);
      return;
    }
    if (outcome.state !== state) props.onState(outcome.state);
  });

  const models = filteredModels(state);
  const statusColor =
    state.status === null
      ? undefined
      : colorFor(state.status.isError ? "tertiary" : "success", capabilities);

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      h(
        Text,
        { bold: true, ...colorProps(colorFor("secondary", capabilities)) },
        "Provider configuration",
      ),
      h(Text, colorProps(colorFor("faint", capabilities)), `  ${state.providerLabel}`),
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Column, {
        title: "Provider",
        focused: state.activeColumn === "provider",
        capabilities,
        children: [
          h(Row, {
            key: "p0",
            text: state.providerLabel,
            focused: state.activeColumn === "provider",
            selected: true,
            capabilities,
          }),
        ],
      }),
      h(Column, {
        title: "Protocol",
        focused: state.activeColumn === "protocol",
        capabilities,
        children: visibleWindow(state.protocols, state.scroll.protocol).map((protocol, index) =>
          h(Row, {
            key: protocol,
            text: protocol,
            focused: state.activeColumn === "protocol",
            selected: state.scroll.protocol + index === state.protocolIndex,
            capabilities,
          }),
        ),
      }),
      h(Column, {
        title: "Model",
        focused: state.activeColumn === "model",
        capabilities,
        children: visibleWindow(models, state.scroll.model).map((entry, index) =>
          h(Row, {
            key: entry.id,
            text: entry.source === "fetched" ? `${entry.id} *` : entry.id,
            focused: state.activeColumn === "model",
            selected: state.scroll.model + index === state.modelIndex,
            capabilities,
          }),
        ),
      }),
    ),
    h(
      Box,
      { marginTop: 1 },
      h(
        Text,
        colorProps(colorFor("faint", capabilities)),
        state.filterMode
          ? `filter: ${state.filter}_  (enter applies, esc clears)`
          : "tab/left/right column - up/down move - enter apply - del remove - ctrl+z undo",
      ),
    ),
    state.status === null
      ? null
      : h(Box, null, h(Text, colorProps(statusColor), state.status.text)),
    h(
      Box,
      null,
      h(
        Text,
        colorProps(colorFor("faint", capabilities)),
        `${models.length} model(s)  * = fetched from the provider`,
      ),
    ),
  );
}

function Column(props: {
  title: string;
  focused: boolean;
  capabilities: Capabilities;
  children: readonly ReactElement[];
}): ReactElement {
  const { capabilities, focused } = props;
  const titleStyle = rowStyle({ role: "secondary", focused, capabilities });
  return h(
    Box,
    { flexDirection: "column", width: 26, marginRight: 1 },
    h(
      Text,
      {
        ...(titleStyle.bold ? { bold: true } : {}),
        ...colorProps(titleStyle.color),
        ...(titleStyle.inverse ? { inverse: true } : {}),
      },
      props.title,
    ),
    ...props.children,
  );
}

function Row(props: {
  text: string;
  focused: boolean;
  selected: boolean;
  capabilities: Capabilities;
}): ReactElement {
  const style = rowStyle({
    role: props.focused ? "primary" : "dim",
    focused: props.focused && props.selected,
    capabilities: props.capabilities,
  });
  const marker = props.selected ? ">" : " ";
  return h(
    Box,
    null,
    h(Text, colorProps(colorFor("faint", props.capabilities)), `${marker} `),
    h(
      Text,
      {
        ...colorProps(style.color),
        ...(style.bold ? { bold: true } : {}),
        ...(style.inverse ? { inverse: true } : {}),
      },
      truncate(props.text, 23),
    ),
  );
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Translate Ink's key event into the reducer's vocabulary. */
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
  },
): BrowserKey | null {
  if (key.ctrl === true && input === "z") return "undo";
  if (key.leftArrow === true) return "left";
  if (key.rightArrow === true) return "right";
  if (key.upArrow === true) return "up";
  if (key.downArrow === true) return "down";
  if (key.tab === true) return "tab";
  if (key.return === true) return "enter";
  if (key.escape === true) return "escape";
  if (key.backspace === true) return "backspace";
  if (key.delete === true) return "delete";
  if (input.length > 0 && !key.ctrl) return { kind: "text", value: input };
  return null;
}

export { BROWSER_LIMITS };

/** Build Ink's color prop only when a colour is available at this depth. */
function colorProps(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}
