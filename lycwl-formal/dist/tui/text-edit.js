const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const characters = (value) => [...segmenter.segment(value)].map(({ segment }) => segment);
export function editText(current, input, key) {
    const parts = characters(current.value);
    const cursor = Math.min(current.cursor, parts.length);
    if (key.home || (key.ctrl && input === "a"))
        return { ...current, cursor: 0 };
    if (key.end || (key.ctrl && input === "e"))
        return { ...current, cursor: parts.length };
    if (key.leftArrow)
        return { ...current, cursor: Math.max(0, cursor - 1) };
    if (key.rightArrow)
        return { ...current, cursor: Math.min(parts.length, cursor + 1) };
    if (key.ctrl && input === "u")
        return { value: "", cursor: 0 };
    if (key.ctrl || key.meta)
        return current;
    if (key.backspace) {
        if (cursor === 0)
            return current;
        parts.splice(cursor - 1, 1);
        return { value: parts.join(""), cursor: cursor - 1 };
    }
    if (key.delete) {
        parts.splice(cursor, 1);
        return { value: parts.join(""), cursor };
    }
    // A single-line paste must not inject terminal controls or submit commands.
    const inserted = characters(input.replace(/\p{Control}/gu, ""));
    if (inserted.length === 0)
        return current;
    parts.splice(cursor, 0, ...inserted);
    return { value: parts.join(""), cursor: cursor + inserted.length };
}
