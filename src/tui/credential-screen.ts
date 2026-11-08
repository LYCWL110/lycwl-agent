import { Box, Text, useInput, usePaste } from "ink";
import { createElement as h, type ReactElement, useState } from "react";
import { CREDENTIAL_LIMITS } from "../ports/credential-vault.ts";
import { characters, editText, type TextEdit } from "./text-edit.ts";
import { TextInput } from "./text-input.ts";

/** Secret input stays in this component; it never passes through the composer. */
export function CredentialScreen(props: {
  width: number;
  onSave: (secret: string) => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [editor, setEditor] = useState<TextEdit>({ value: "", cursor: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useInput((input, key) => {
    if (busy) return;
    if (key.escape || (key.ctrl && input === "c")) {
      props.onClose();
      return;
    }
    if (key.return) {
      if (editor.value.length === 0) return;
      const secret = editor.value;
      setBusy(true);
      setEditor({ value: "", cursor: 0 });
      void props
        .onSave(secret)
        .then((ok) => {
          setError(!ok);
        })
        .catch(() => setError(true))
        .finally(() => setBusy(false));
      return;
    }
    const edited = editText(editor, input, key);
    if (Buffer.byteLength(edited.value, "utf8") <= CREDENTIAL_LIMITS.maxSecretBytes) {
      setEditor(edited);
      setError(false);
    }
  });
  usePaste((text) => {
    if (!busy && Buffer.byteLength(editor.value + text, "utf8") <= CREDENTIAL_LIMITS.maxSecretBytes)
      setEditor({ value: editor.value + text, cursor: characters(editor.value + text).length });
  });
  const width = Math.max(1, props.width);
  return h(
    Box,
    { width, flexDirection: "column" },
    h(Text, { bold: true, wrap: "wrap" }, "Current connection API key"),
    h(TextInput, { ...editor, width, sensitive: true }),
    h(
      Text,
      { wrap: "wrap" },
      busy ? "Saving..." : error ? "Key not saved" : "Enter save / Esc cancel",
    ),
  );
}
