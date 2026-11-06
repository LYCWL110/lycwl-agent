import { createHash } from "node:crypto";
import type { ConfigDocument, ConfigStore } from "../adapters/windows/config-store.ts";
import type { FileVault } from "../adapters/windows/file-credential-vault.ts";
import { parseJsonc, toPlainValue } from "../domain/config/jsonc.ts";
import { insertTopLevelValue, replaceTopLevelValue } from "../domain/config/jsonc-edit.ts";
import {
  type ProviderConfigResult,
  readProviderConfig,
  validateProviderConfig,
} from "../domain/config/provider-config.ts";
import type { SetupDraft, SetupField } from "../tui/setup-screen.ts";

/**
 * Persist a setup draft.
 *
 * Order matters: validate first, write the credential second, write settings last.
 * If the settings write fails, an unreferenced credential may remain, which is
 * recoverable. The reverse order would leave settings pointing at a key that was
 * never stored, which fails later as an opaque authentication error.
 */

export const DEFAULT_SCHEMA_HEADER = `{
  "schemaVersion": 1,
  "revision": 0
}
`;

export type SaveSetupResult =
  | Readonly<{
      ok: true;
      config: Readonly<{
        protocol: string;
        baseUrl: string;
        model: string;
        credentialRef: string;
        maxOutputTokens: number;
      }>;
      credentialWritten: boolean;
      document: ConfigDocument | null;
    }>
  | Readonly<{
      ok: false;
      code:
        | "invalid_draft"
        | "validation_failed"
        | "credential_write_failed"
        | "config_write_failed"
        | "config_conflict";
      field?: SetupField;
      detail?: string;
      /** Present on a conflict: the draft the user must keep. */
      draft?: string;
    }>;

export async function saveSetup(input: {
  draft: SetupDraft;
  vault: FileVault;
  store: ConfigStore;
  /** The document the user edited, so another save cannot be silently overwritten. */
  baseDocument?: ConfigDocument | null;
}): Promise<SaveSetupResult> {
  const current = await input.store.load();
  if (!current.ok && current.code !== "config_missing") {
    return { ok: false, code: "config_write_failed", detail: current.code };
  }
  const base =
    input.baseDocument === undefined ? (current.ok ? current.value : null) : input.baseDocument;
  const existing = readProviderConfig(base === null ? {} : parseSettings(base.text));
  const validated = validateProviderConfig({
    protocol:
      input.draft.protocol ?? (existing.ok ? existing.value.protocol : "anthropic_messages"),
    baseUrl: input.draft.baseUrl,
    model: input.draft.model,
    credentialRef: input.draft.credentialRef,
    ...(existing.ok ? { maxOutputTokens: existing.value.maxOutputTokens } : {}),
  });
  if (!validated.ok) {
    const field = mapField(validated.field);
    return {
      ok: false,
      code: "validation_failed",
      ...(field === undefined ? {} : { field }),
      detail: validated.code,
    };
  }
  const config = validated.value;
  const withProvider = writeProviderBlock(base?.text ?? DEFAULT_SCHEMA_HEADER, {
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    credentialRef: config.credentialRef,
    maxOutputTokens: config.maxOutputTokens,
  });
  if (!withProvider.ok) {
    return { ok: false, code: "config_write_failed", detail: withProvider.code };
  }
  // Reject an already-stale form before it can replace a stored credential.
  // The store still rechecks this snapshot under its lock at the final save.
  if (
    (current.ok ? current.value.documentHash : "") !== (base?.documentHash ?? "") ||
    (current.ok ? current.value.revision : 0) !== (base?.revision ?? 0)
  ) {
    return { ok: false, code: "config_conflict", draft: withProvider.text };
  }

  // An empty key is allowed only when a credential already exists for the
  // reference; otherwise the configuration would look complete and fail on send.
  let credentialWritten = false;
  if (input.draft.apiKey.length > 0) {
    const written = await input.vault.write({
      reference: config.credentialRef,
      purpose: "provider_api_key",
      secret: input.draft.apiKey,
    });
    if (!written.ok) {
      return { ok: false, code: "credential_write_failed", detail: written.code };
    }
    credentialWritten = true;
  } else {
    const existing = await input.vault.read({
      reference: config.credentialRef,
      purpose: "provider_api_key",
      revision: 1,
    });
    if (!existing.ok) {
      return {
        ok: false,
        code: "credential_write_failed",
        field: "apiKey",
        detail: existing.code,
      };
    }
  }

  const baseRevision = base?.revision ?? 0;
  const baseDocumentHash = base?.documentHash ?? "";
  const saved = await input.store.save({
    baseRevision,
    baseDocumentHash,
    draft: withProvider.text,
  });
  if (!saved.ok) {
    if (saved.code === "config_conflict") {
      return {
        ok: false,
        code: "config_conflict",
        draft: withProvider.text,
      };
    }
    return { ok: false, code: "config_write_failed", detail: saved.code };
  }

  // The round trip must describe what was just written; if it does not, the
  // document is not usable and pretending otherwise would fail at Run start.
  const reread = readProviderConfig(parseSettings(saved.value.text));
  if (!reread.ok) {
    return { ok: false, code: "config_write_failed", detail: reread.code };
  }

  return {
    ok: true,
    config: {
      protocol: reread.value.protocol,
      baseUrl: reread.value.baseUrl,
      model: reread.value.model,
      credentialRef: reread.value.credentialRef,
      maxOutputTokens: reread.value.maxOutputTokens,
    },
    credentialWritten,
    document: saved.value,
  };
}

type ProviderBlock = Readonly<{
  protocol: string;
  baseUrl: string;
  model: string;
  credentialRef: string;
  maxOutputTokens: number;
}>;

/**
 * Insert or replace the `provider` object in the settings document.
 *
 * The localized editor only writes scalars, and the provider block is an object, so
 * this splices the serialized object directly. Two details matter:
 *
 * - the block is written as a real object, never as a JSON-escaped string, which
 *   is what a scalar editor would produce;
 * - everything outside the block span is preserved, so comments survive.
 */
function writeProviderBlock(
  text: string,
  block: ProviderBlock,
): Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; code: string }> {
  const literal = serializeObjectLiteral(block);
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, code: "invalid_document" };
  if (parsed.value.kind !== "object") return { ok: false, code: "root_not_object" };

  const existing = parsed.value.members.find((member) => member.key === "provider");
  if (existing !== undefined) {
    if (existing.value.kind !== "object") return { ok: false, code: "invalid_provider" };
    let providerText = text.slice(existing.value.start, existing.value.end);
    for (const [key, value] of Object.entries(block)) {
      const provider = parseJsonc(providerText);
      if (!provider.ok || provider.value.kind !== "object") {
        return { ok: false, code: "invalid_provider" };
      }
      const present = provider.value.members.some((member) => member.key === key);
      const edited = present
        ? replaceTopLevelValue(providerText, key, value)
        : insertTopLevelValue(providerText, key, value);
      if (!edited.ok) return edited;
      providerText = edited.text;
    }
    return {
      ok: true,
      text: `${text.slice(0, existing.value.start)}${providerText}${text.slice(existing.value.end)}`,
    };
  }

  return insertRawTopLevel(text, "provider", literal);
}

/**
 * Render a nested object with two-space indentation, indented as a top-level value.
 */
function serializeObjectLiteral(block: ProviderBlock): string {
  const inner = [
    `"protocol": ${JSON.stringify(block.protocol)}`,
    `"baseUrl": ${JSON.stringify(block.baseUrl)}`,
    `"model": ${JSON.stringify(block.model)}`,
    `"credentialRef": ${JSON.stringify(block.credentialRef)}`,
    `"maxOutputTokens": ${block.maxOutputTokens}`,
  ].join(",\n    ");
  return `{\n    ${inner}\n  }`;
}

/**
 * Insert a raw JSON literal at the top level.
 *
 * `insertTopLevelValue` only accepts scalars, and the provider block is an object;
 * this mirrors its placement logic for a pre-serialized literal.
 */
function insertRawTopLevel(
  text: string,
  key: string,
  literal: string,
): Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; code: string }> {
  const keyText = JSON.stringify(key);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";

  // Find the last top-level `}`; the document is validated before this point.
  const close = text.lastIndexOf("}");
  if (close === -1) return { ok: false, code: "invalid_document" };

  const before = text.slice(0, close);
  const trimmed = before.replace(/\s+$/, "");
  const endsWithComma = trimmed.endsWith(",");
  const separator = endsWithComma ? "" : ",";
  const trailing = text.slice(trimmed.length, close);

  const block = `${trimmed}${separator}${newline}  ${keyText}: ${literal}`;
  return { ok: true, text: `${block}${trailing}${text.slice(close)}` };
}

/** Parse through the same JSONC parser the store validates with. */
function parseSettings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : {};
}

function mapField(field: string | undefined): SetupField | undefined {
  if (field === "protocol") return "protocol";
  if (field === "baseUrl") return "baseUrl";
  if (field === "model") return "model";
  if (field === "credentialRef") return "credentialRef";
  return undefined;
}

/** Stable hash for a draft, used only for diagnostics. */
export function draftHash(draft: SetupDraft): string {
  return createHash("sha256")
    .update(`${draft.baseUrl}\u0000${draft.model}\u0000${draft.credentialRef}`, "utf8")
    .digest("hex");
}

export type { ProviderConfigResult };
