import type { ExplicitReasoningEffort } from "./model-catalog.ts";
import type { SupportedProtocol } from "./provider-config.ts";

export const REASONING_REFERENCE_SOURCE = Object.freeze({
  revision: "7ab721a97f383b89a8d901c87866b1565c1cfd9c",
  path: "packages/core/src/models-dev/snapshot.txt",
  snapshotSha256: "5d5740c70071aa628d1efe317f6885faf1f20b32a9fcb502553f57cce15cf9f1",
  projectionSha256: "3f19328fc8610c6161b81f32b4f8a79438adae71009cba4183c7c2087006b29e",
  retrievedOn: "2026-11-07",
});

type ReferenceGroup = Readonly<{
  provider: string;
  models: readonly string[];
  protocols: readonly SupportedProtocol[];
  efforts: readonly ExplicitReasoningEffort[];
}>;

// Explicit effort arrays only. Budget/toggle variants and deprecated entries are excluded.
const groups: readonly ReferenceGroup[] = [
  {
    provider: "openai",
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["minimal", "low", "medium", "high"],
  },
  {
    provider: "openai",
    models: ["gpt-5.1"],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["none", "low", "medium", "high"],
  },
  {
    provider: "openai",
    models: ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    provider: "openai",
    models: ["gpt-5.3-codex", "gpt-5.3-codex-spark"],
    protocols: ["openai_responses"],
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    provider: "openai",
    models: ["gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"],
    protocols: ["openai_responses"],
    efforts: ["medium", "high", "xhigh"],
  },
  {
    provider: "openai",
    models: ["gpt-5-pro"],
    protocols: ["openai_responses"],
    efforts: ["high"],
  },
  {
    provider: "openai",
    models: [
      "gpt-5.6",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-terra",
    ],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "openai",
    models: ["gpt-5.6-cyber", "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"],
    protocols: ["openai_responses"],
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "openai",
    models: ["gpt-6-astra", "gpt-6.1-sol"],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "openai",
    models: ["o3"],
    protocols: ["openai_chat", "openai_responses"],
    efforts: ["low", "medium", "high"],
  },
  {
    provider: "openai",
    models: ["o3-pro"],
    protocols: ["openai_responses"],
    efforts: ["low", "medium", "high"],
  },
  {
    provider: "anthropic",
    models: ["claude-opus-4-5", "claude-opus-4-5-20251101"],
    protocols: ["anthropic_messages", "openai_chat"],
    efforts: ["low", "medium", "high"],
  },
  {
    provider: "anthropic",
    models: ["claude-opus-4-6", "claude-sonnet-4-6"],
    protocols: ["anthropic_messages", "openai_chat"],
    efforts: ["low", "medium", "high", "max"],
  },
  {
    provider: "anthropic",
    models: [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-5-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
    ],
    protocols: ["anthropic_messages", "openai_chat"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "deepseek",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    protocols: ["anthropic_messages", "openai_chat"],
    efforts: ["low", "high", "max"],
  },
];

export type ReasoningReference = Readonly<{
  provider: string;
  id: string;
  protocols: readonly SupportedProtocol[];
  efforts: readonly ExplicitReasoningEffort[];
}>;

export const REASONING_REFERENCES: readonly ReasoningReference[] = Object.freeze(
  groups.flatMap((group) =>
    group.models.map((id) =>
      Object.freeze({
        provider: group.provider,
        id,
        protocols: Object.freeze([...group.protocols]),
        efforts: Object.freeze([...group.efforts]),
      }),
    ),
  ),
);

/** Reference hints only: exact catalog identities never establish relay support. */
export function referenceReasoningFor(
  protocol: string,
  model: string,
): ReasoningReference | undefined {
  const matches = REASONING_REFERENCES.filter(
    (entry) =>
      entry.protocols.some((value) => value === protocol) &&
      (model === entry.id || model === `${entry.provider}/${entry.id}`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
