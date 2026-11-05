/**
 * Deterministic prompt rendering (ADR-0016 P01).
 *
 * A render is a pure transform of explicit inputs. Nothing here reads the
 * filesystem, environment, clock, network or randomness, so the same input
 * always produces byte-identical output and a snapshot failure is meaningful.
 *
 * Provenance is structural, not textual. Four sources exist and each keeps its
 * own kind; a project document that imitates a system message stays
 * `project_material`. Prefix matching and "ignore injection" text are not
 * security boundaries and are not used as one.
 */

export type PromptSourceKind =
  /** Release-bundled trusted Harness rules. */
  | "harness_rule"
  /** Actual user task input through the trusted application boundary. */
  | "user_input"
  /** Untrusted project or tool material with an identifiable origin. */
  | "project_material"
  /** Authoritative Runtime projection facts. */
  | "runtime_fact";

export const PROMPT_BLOCK_ORDER: readonly PromptSourceKind[] = Object.freeze([
  "harness_rule",
  "runtime_fact",
  "project_material",
  "user_input",
]);

export type PromptBlock = Readonly<{
  /** Stable identifier; must be unique within a render. */
  id: string;
  source: PromptSourceKind;
  text: string;
  /**
   * Identifies where the content came from, for untrusted material especially.
   * Never used to decide authority: `source` does.
   */
  origin: string | null;
}>;

export const TEMPLATE_LIMITS = Object.freeze({
  maxBlockBytes: 256 * 1024,
  maxBlocks: 512,
  maxTemplateIdLength: 128,
});

export type TemplateIdentity = Readonly<{
  templateId: string;
  templateVersion: number;
  contentSha256: string;
}>;

export type PromptBundle = Readonly<{
  bundleVersion: string;
  /** Fixed Harness rule templates shipped with the product. */
  harnessRules: readonly TemplateIdentity[];
  workflowGuide: TemplateIdentity;
  summaryInstruction: TemplateIdentity;
}>;

export type RenderFailure =
  | "invalid_block"
  | "duplicate_block_id"
  | "unknown_source"
  | "too_many_blocks"
  | "block_too_large"
  | "invalid_template_identity"
  | "invalid_bundle"
  | "unsupported_role_mapping";

export type PromptRenderManifest = Readonly<{
  bundleVersion: string;
  /** Ordered record of what went into the render. */
  blocks: readonly Readonly<{
    id: string;
    source: PromptSourceKind;
    origin: string | null;
    bytes: number;
    /** First 16 hex characters of the block content hash. */
    contentSha256: string;
  }>[];
  rendererVersion: string;
  /** Adapter/protocol this render targets; role mapping depends on it. */
  adapterVersion: string;
  totalBytes: number;
}>;

export type PromptRender = Readonly<{
  /**
   * Rendered blocks in canonical order. A caller maps these onto Provider
   * messages; the mapping must preserve `source`.
   */
  blocks: readonly PromptBlock[];
  manifest: PromptRenderManifest;
}>;

export type PromptRenderResult =
  | Readonly<{ ok: true; value: PromptRender }>
  | Readonly<{ ok: false; code: RenderFailure; detail?: string }>;

/** A hash function injected by the caller, so domain code stays runtime-free. */
export type Sha256Hex = (text: string) => string;

/**
 * Canonical render. Ordering is fixed by `PROMPT_BLOCK_ORDER`, then by block id
 * within a source, so block insertion order cannot change the output.
 */
export function renderPrompt(input: {
  bundle: PromptBundle;
  blocks: readonly PromptBlock[];
  adapterVersion: string;
  rendererVersion: string;
  sha256Hex: Sha256Hex;
}): PromptRenderResult {
  const bundleFailure = validateBundle(input.bundle);
  if (bundleFailure !== null) return { ok: false, code: bundleFailure };
  if (input.blocks.length > TEMPLATE_LIMITS.maxBlocks) {
    return { ok: false, code: "too_many_blocks" };
  }

  const ids = new Set<string>();
  for (const block of input.blocks) {
    if (typeof block.id !== "string" || block.id.length === 0) {
      return { ok: false, code: "invalid_block" };
    }
    if (typeof block.text !== "string") return { ok: false, code: "invalid_block" };
    if (ids.has(block.id)) {
      return { ok: false, code: "duplicate_block_id", detail: block.id };
    }
    ids.add(block.id);
    if (!PROMPT_BLOCK_ORDER.includes(block.source)) {
      return { ok: false, code: "unknown_source", detail: block.source };
    }
    if (utf8Length(block.text) > TEMPLATE_LIMITS.maxBlockBytes) {
      return { ok: false, code: "block_too_large", detail: block.id };
    }
  }

  const ordered = [...input.blocks].sort((left, right) => {
    const rank = PROMPT_BLOCK_ORDER.indexOf(left.source) - PROMPT_BLOCK_ORDER.indexOf(right.source);
    if (rank !== 0) return rank;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  let totalBytes = 0;
  const manifestBlocks: {
    id: string;
    source: PromptSourceKind;
    origin: string | null;
    bytes: number;
    contentSha256: string;
  }[] = [];

  for (const block of ordered) {
    const bytes = utf8Length(block.text);
    totalBytes += bytes;
    manifestBlocks.push({
      id: block.id,
      source: block.source,
      origin: block.origin,
      bytes,
      contentSha256: input.sha256Hex(block.text).slice(0, 16),
    });
  }

  return {
    ok: true,
    value: {
      blocks: ordered,
      manifest: {
        bundleVersion: input.bundle.bundleVersion,
        blocks: manifestBlocks,
        rendererVersion: input.rendererVersion,
        adapterVersion: input.adapterVersion,
        totalBytes,
      },
    },
  };
}

/**
 * Which role a rendered block may take for a given adapter.
 *
 * Only trusted Harness rules may occupy a system/developer position. Project
 * material is never promoted, because doing so would let a repository document
 * acquire the authority of application configuration.
 */
export type ProviderRole = "system" | "user" | "tool";

export function roleForBlock(
  source: PromptSourceKind,
  adapter: "structured" | "single_user",
): ProviderRole {
  if (source === "harness_rule") return "system";
  if (source === "runtime_fact" || source === "project_material" || source === "user_input") {
    // An adapter without structured roles must merge untrusted material into a
    // user turn; it must never be merged into the system position.
    return "user";
  }
  void adapter;
  return "user";
}

/**
 * Verify a role mapping actually used by an adapter. A render whose mapping
 * promotes untrusted material is rejected rather than downgraded.
 */
export function validateRoleMapping(
  mapping: readonly Readonly<{ source: PromptSourceKind; role: ProviderRole }>[],
): PromptRenderResult | null {
  for (const entry of mapping) {
    const expected = roleForBlock(entry.source, "structured");
    if (entry.source === "harness_rule" && entry.role !== "system") {
      // A trusted rule demoted to user text is a behaviour loss but not an
      // escalation; it is reported instead of silently accepted.
      return { ok: false, code: "unsupported_role_mapping", detail: entry.source };
    }
    if (entry.source !== "harness_rule" && entry.role !== expected) {
      return { ok: false, code: "unsupported_role_mapping", detail: entry.source };
    }
  }
  return null;
}

function validateBundle(bundle: PromptBundle): RenderFailure | null {
  if (typeof bundle.bundleVersion !== "string" || bundle.bundleVersion.length === 0) {
    return "invalid_bundle";
  }
  if (bundle.harnessRules.length === 0) return "invalid_bundle";
  for (const identity of [
    ...bundle.harnessRules,
    bundle.workflowGuide,
    bundle.summaryInstruction,
  ]) {
    const failure = validateTemplateIdentity(identity);
    if (failure !== null) return failure;
  }
  return null;
}

function validateTemplateIdentity(identity: TemplateIdentity): RenderFailure | null {
  if (typeof identity.templateId !== "string" || identity.templateId.length === 0) {
    return "invalid_template_identity";
  }
  if (identity.templateId.length > TEMPLATE_LIMITS.maxTemplateIdLength) {
    return "invalid_template_identity";
  }
  if (!Number.isSafeInteger(identity.templateVersion) || identity.templateVersion < 1) {
    return "invalid_template_identity";
  }
  if (!/^[0-9a-f]{64}$/.test(identity.contentSha256)) return "invalid_template_identity";
  return null;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
