import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  PROMPT_BLOCK_ORDER,
  type PromptBlock,
  type PromptBundle,
  renderPrompt,
  roleForBlock,
  validateRoleMapping,
} from "../../src/domain/context/prompt-render.ts";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const identity = (templateId: string) => ({
  templateId,
  templateVersion: 1,
  contentSha256: sha256Hex(templateId),
});

const BUNDLE: PromptBundle = {
  bundleVersion: "bundle-1",
  harnessRules: [identity("harness-core"), identity("harness-tools")],
  workflowGuide: identity("workflow"),
  summaryInstruction: identity("summary"),
};

function render(blocks: readonly PromptBlock[], bundle: PromptBundle = BUNDLE) {
  return renderPrompt({
    bundle,
    blocks,
    adapterVersion: "adapter-1",
    rendererVersion: "renderer-1",
    sha256Hex,
  });
}

const baseBlocks: readonly PromptBlock[] = [
  { id: "u1", source: "user_input", text: "do the task", origin: null },
  { id: "h1", source: "harness_rule", text: "be careful", origin: null },
  { id: "p1", source: "project_material", text: "project notes", origin: "AGENTS.md" },
  { id: "r1", source: "runtime_fact", text: "round 1 of 32", origin: null },
];

describe("prompt render determinism", () => {
  it("produces identical output regardless of block insertion order", () => {
    const a = render(baseBlocks);
    const b = render([...baseBlocks].reverse());
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.deepEqual(a.value, b.value);
  });

  it("orders blocks by the canonical source order", () => {
    const result = render(baseBlocks);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.blocks.map((block) => block.source),
      ["harness_rule", "runtime_fact", "project_material", "user_input"],
    );
  });

  it("keeps the declared order list itself immutable and complete", () => {
    assert.deepEqual(
      [...PROMPT_BLOCK_ORDER],
      ["harness_rule", "runtime_fact", "project_material", "user_input"],
    );
  });

  it("sorts blocks by id within one source", () => {
    const result = render([
      { id: "z", source: "harness_rule", text: "later", origin: null },
      { id: "a", source: "harness_rule", text: "earlier", origin: null },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.blocks.map((block) => block.id),
      ["a", "z"],
    );
  });

  it("records per-block provenance and hash prefix in the manifest", () => {
    const result = render(baseBlocks);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const projectEntry = result.value.manifest.blocks.find((block) => block.id === "p1");
    assert.ok(projectEntry);
    assert.equal(projectEntry.source, "project_material");
    assert.equal(projectEntry.origin, "AGENTS.md");
    assert.equal(projectEntry.contentSha256, sha256Hex("project notes").slice(0, 16));
    assert.equal(result.value.manifest.bundleVersion, "bundle-1");
    assert.equal(result.value.manifest.adapterVersion, "adapter-1");
    assert.equal(result.value.manifest.rendererVersion, "renderer-1");
  });

  it("reports the total byte size", () => {
    const result = render([{ id: "a", source: "user_input", text: "abc", origin: null }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.manifest.totalBytes, 3);
  });
});

describe("prompt render validation", () => {
  it("rejects a duplicate block id", () => {
    const result = render([
      { id: "x", source: "user_input", text: "a", origin: null },
      { id: "x", source: "runtime_fact", text: "b", origin: null },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "duplicate_block_id");
  });

  it("rejects an empty block id", () => {
    const result = render([{ id: "", source: "user_input", text: "a", origin: null }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_block");
  });

  it("rejects an unknown source kind", () => {
    const result = render([{ id: "x", source: "system" as never, text: "a", origin: null }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unknown_source");
  });

  it("rejects an empty bundle", () => {
    const result = render([], { ...BUNDLE, harnessRules: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_bundle");
  });

  it("rejects a template identity with a non-hex hash", () => {
    const result = render([], {
      ...BUNDLE,
      workflowGuide: { templateId: "workflow", templateVersion: 1, contentSha256: "nope" },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_template_identity");
  });

  it("rejects a template version below 1", () => {
    const result = render([], {
      ...BUNDLE,
      summaryInstruction: {
        templateId: "summary",
        templateVersion: 0,
        contentSha256: sha256Hex("x"),
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_template_identity");
  });

  it("rejects a block above the byte bound", () => {
    const result = render([
      { id: "big", source: "user_input", text: "x".repeat(256 * 1024 + 1), origin: null },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "block_too_large");
  });
});

describe("prompt role mapping preserves provenance", () => {
  it("gives only trusted harness rules the system role", () => {
    assert.equal(roleForBlock("harness_rule", "structured"), "system");
    assert.equal(roleForBlock("runtime_fact", "structured"), "user");
    assert.equal(roleForBlock("project_material", "structured"), "user");
    assert.equal(roleForBlock("user_input", "structured"), "user");
  });

  it("never promotes project material to system, even for a single-user adapter", () => {
    assert.equal(roleForBlock("project_material", "single_user"), "user");
  });

  it("rejects a mapping that promotes untrusted material", () => {
    const failure = validateRoleMapping([
      { source: "harness_rule", role: "system" },
      { source: "project_material", role: "system" },
    ]);
    assert.ok(failure !== null);
    assert.equal(failure.ok, false);
    if (failure.ok) return;
    assert.equal(failure.code, "unsupported_role_mapping");
    assert.equal(failure.detail, "project_material");
  });

  it("accepts a correct mapping", () => {
    const failure = validateRoleMapping([
      { source: "harness_rule", role: "system" },
      { source: "project_material", role: "user" },
      { source: "user_input", role: "user" },
      { source: "runtime_fact", role: "user" },
    ]);
    assert.equal(failure, null);
  });

  it("reports a demoted harness rule rather than silently accepting it", () => {
    const failure = validateRoleMapping([{ source: "harness_rule", role: "user" }]);
    assert.ok(failure !== null);
    assert.equal(failure.ok, false);
  });
});
