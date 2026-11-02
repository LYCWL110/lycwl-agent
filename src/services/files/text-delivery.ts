import type { TextSnapshot } from "./text-snapshot.ts";

export type TextDelivery = Readonly<{
  text: string;
  modelTextUnits: number;
  modelTextTruncated: boolean;
  modelTextTruncationReason: "model_budget" | null;
}>;

const MAX_MODEL_TEXT_UNITS = 20_000;

export function boundTextSnapshotForModel(snapshot: TextSnapshot): TextDelivery {
  if (snapshot.content.length <= MAX_MODEL_TEXT_UNITS) {
    return {
      text: snapshot.content,
      modelTextUnits: snapshot.content.length,
      modelTextTruncated: false,
      modelTextTruncationReason: null,
    };
  }

  let end = MAX_MODEL_TEXT_UNITS;
  const lastUnit = snapshot.content.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  if (snapshot.content.charCodeAt(end - 1) === 0x0d && snapshot.content.charCodeAt(end) === 0x0a) {
    end -= 1;
  }
  const text = snapshot.content.slice(0, end);

  return {
    text,
    modelTextUnits: text.length,
    modelTextTruncated: true,
    modelTextTruncationReason: "model_budget",
  };
}
