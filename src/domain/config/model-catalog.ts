import type { ReasoningEffort } from "./provider-config.ts";

export type ExplicitReasoningEffort = Exclude<ReasoningEffort, "default">;

/** A catalog declaration is configuration guidance, not tested compatibility. */
export type CatalogModel = Readonly<{
  id: string;
  /** Recognized metadata was malformed or conflicting; do not apply reference fallback. */
  reasoningInvalid?: true;
  /** Missing means unknown; an empty list declares no selectable effort values. */
  reasoning?: Readonly<{
    efforts: readonly ExplicitReasoningEffort[];
    defaultEffort?: ExplicitReasoningEffort;
  }>;
}>;
