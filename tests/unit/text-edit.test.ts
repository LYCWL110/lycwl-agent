import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cellWidth } from "../../src/tui/chrome.ts";
import { characters, editText } from "../../src/tui/text-edit.ts";
import { inputWindow } from "../../src/tui/text-input.ts";

describe("input caret editing", () => {
  it("inserts and deletes at the caret without splitting graphemes", () => {
    let editor = { value: "中👩‍💻e\u0301x", cursor: 4 };
    editor = editText(editor, "", { leftArrow: true });
    editor = editText(editor, "", { backspace: true });
    assert.deepEqual(editor, { value: "中👩‍💻x", cursor: 2 });
    editor = editText(editor, "文", {});
    editor = editText(editor, "", { delete: true });
    assert.deepEqual(editor, { value: "中👩‍💻文", cursor: 3 });
    editor = editText(editor, "", { home: true });
    editor = editText(editor, "A", {});
    editor = editText(editor, "", { end: true });
    assert.equal(editor.cursor, characters(editor.value).length);
  });
  it("clears a value and removes paste controls without submitting", () => {
    const cleared = editText({ value: "old", cursor: 3 }, "u", { ctrl: true });
    assert.deepEqual(cleared, { value: "", cursor: 0 });
    assert.deepEqual(editText(cleared, "new\r\nvalue\t\u001b", {}), {
      value: "newvalue",
      cursor: 8,
    });
  });
  it("scrolls to the insertion point and masks every secret fragment", () => {
    const value = "https://example.test/a-long-path/v1";
    const ending = inputWindow(value, characters(value).length, 12);
    assert.ok(ending.before.endsWith("/v1"));
    assert.equal(ending.caret, " ");
    assert.ok(cellWidth(ending.before + ending.caret + ending.after) <= 12);
    const beginning = inputWindow(value, 0, 12);
    assert.equal(beginning.caret, "h");
    const masked = inputWindow("fixture-secret", 5, 8, true);
    assert.match(masked.before + masked.caret + masked.after, /^\*+$/);
  });
});
