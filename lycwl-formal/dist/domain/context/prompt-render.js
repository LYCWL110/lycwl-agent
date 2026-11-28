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
export const PROMPT_BLOCK_ORDER = Object.freeze([
    "harness_rule",
    "runtime_fact",
    "project_material",
    "user_input",
]);
export const TEMPLATE_LIMITS = Object.freeze({
    maxBlockBytes: 256 * 1024,
    maxBlocks: 512,
    maxTemplateIdLength: 128,
});
/**
 * Canonical render. Ordering is fixed by `PROMPT_BLOCK_ORDER`, then by block id
 * within a source, so block insertion order cannot change the output.
 */
export function renderPrompt(input) {
    const bundleFailure = validateBundle(input.bundle);
    if (bundleFailure !== null)
        return { ok: false, code: bundleFailure };
    if (input.blocks.length > TEMPLATE_LIMITS.maxBlocks) {
        return { ok: false, code: "too_many_blocks" };
    }
    const ids = new Set();
    for (const block of input.blocks) {
        if (typeof block.id !== "string" || block.id.length === 0) {
            return { ok: false, code: "invalid_block" };
        }
        if (typeof block.text !== "string")
            return { ok: false, code: "invalid_block" };
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
        if (rank !== 0)
            return rank;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    let totalBytes = 0;
    const manifestBlocks = [];
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
export function roleForBlock(source, adapter) {
    if (source === "harness_rule")
        return "system";
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
export function validateRoleMapping(mapping) {
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
function validateBundle(bundle) {
    if (typeof bundle.bundleVersion !== "string" || bundle.bundleVersion.length === 0) {
        return "invalid_bundle";
    }
    if (bundle.harnessRules.length === 0)
        return "invalid_bundle";
    for (const identity of [
        ...bundle.harnessRules,
        bundle.workflowGuide,
        bundle.summaryInstruction,
    ]) {
        const failure = validateTemplateIdentity(identity);
        if (failure !== null)
            return failure;
    }
    return null;
}
function validateTemplateIdentity(identity) {
    if (typeof identity.templateId !== "string" || identity.templateId.length === 0) {
        return "invalid_template_identity";
    }
    if (identity.templateId.length > TEMPLATE_LIMITS.maxTemplateIdLength) {
        return "invalid_template_identity";
    }
    if (!Number.isSafeInteger(identity.templateVersion) || identity.templateVersion < 1) {
        return "invalid_template_identity";
    }
    if (!/^[0-9a-f]{64}$/.test(identity.contentSha256))
        return "invalid_template_identity";
    return null;
}
function utf8Length(text) {
    let bytes = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined)
            continue;
        if (codePoint < 0x80)
            bytes += 1;
        else if (codePoint < 0x800)
            bytes += 2;
        else if (codePoint < 0x10000)
            bytes += 3;
        else
            bytes += 4;
    }
    return bytes;
}
