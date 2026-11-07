import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OwnedKeyRegistry } from "../../domain/security/owned-key-guard.ts";

import {
  CREDENTIAL_LIMITS,
  type CredentialFailure,
  type CredentialPurpose,
  type CredentialReference,
  type CredentialResult,
  type CredentialVault,
  validateReference,
} from "../../ports/credential-vault.ts";

/**
 * File-based credential storage.
 *
 * This exists because the reference projects all store credentials in plaintext on
 * Windows: Claude Code writes `primaryApiKey` into `~/.claude.json`, and OpenCode
 * stores a JSON `value` column in SQLite. Neither encrypts, and neither has any
 * Windows-specific protection beyond inherited directory ACLs.
 *
 * This adapter is deliberately **more careful than either**, while accepting the
 * same fundamental limit:
 *
 * - one file per purpose, so a search key and a model key cannot be confused;
 * - the file lives under the application data directory, not the workspace;
 * - restrictive permissions are attempted, and failure is reported rather than
 *   ignored (unlike a silent no-op `chmod`);
 * - writes go through a same-directory temporary file;
 * - a malformed file is reported as unusable instead of silently losing keys.
 *
 * What it does NOT do: it does not protect the value from any process running as
 * the same Windows user. That is the same residual risk Credential Manager has
 * against a hostile same-user process, but without the DPAPI encryption on top.
 * This is recorded in ADR-0038.
 */

export const FILE_VAULT_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024,
  /** A missing file is normal; a corrupt one disables the affected purpose. */
  filename: "credentials.json",
});

export type FileVaultOptions = Readonly<{
  /** Application data directory; the vault owns `credentials.json` inside it. */
  directory: string;
  /** Injected for tests. */
  now?: () => string;
}>;

type StoredEntry = Readonly<{
  purpose: CredentialPurpose;
  reference: string;
  revision: number;
  secret: string;
  updatedAtUtc: string;
}>;

type StoredFile = Readonly<{
  schemaVersion: 1;
  entries: readonly StoredEntry[];
  /** Protective copies have no sending authority and are never auto-deleted. */
  retiredProviderKeys?: readonly StoredEntry[];
}>;

export type FileVault = CredentialVault &
  Readonly<{
    /** Absolute path of the backing file, for diagnostics and tests. */
    filePath: string;
    /** True when restrictive permissions could not be applied on this platform. */
    permissionWarning: () => boolean;
    readProviderProtection: () => Promise<CredentialResult<OwnedKeyRegistry>>;
  }>;

export function createFileVault(options: FileVaultOptions): FileVault {
  const filePath = path.join(options.directory, FILE_VAULT_LIMITS.filename);
  const now = options.now ?? (() => new Date().toISOString());
  let permissionWarned = false;

  async function loadAll(): Promise<
    Readonly<{ ok: true; file: StoredFile }> | Readonly<{ ok: false; code: CredentialFailure }>
  > {
    let raw: string;
    try {
      const bytes = await readFile(filePath);
      if (bytes.byteLength > FILE_VAULT_LIMITS.maxFileBytes) {
        return { ok: false, code: "vault_unavailable" };
      }
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (isNotFound(error)) return { ok: true, file: { schemaVersion: 1, entries: [] } };
      return { ok: false, code: "vault_unavailable" };
    }
    if (raw.length > FILE_VAULT_LIMITS.maxFileBytes) {
      return { ok: false, code: "vault_unavailable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt file must not be treated as empty: that would silently drop
      // every stored key and look like "not configured" instead of "broken".
      return { ok: false, code: "vault_unavailable" };
    }
    const file = parseStoredFile(parsed);
    if (file === null) return { ok: false, code: "vault_unavailable" };
    return { ok: true, file };
  }

  async function persist(file: StoredFile): Promise<CredentialFailure | null> {
    const text = JSON.stringify(file, null, 2);
    if (Buffer.byteLength(text, "utf8") > FILE_VAULT_LIMITS.maxFileBytes) {
      return "vault_unavailable";
    }
    const temporary = path.join(
      options.directory,
      `${FILE_VAULT_LIMITS.filename}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await mkdir(options.directory, { recursive: true });
      // 0o600 is honoured on POSIX. On Windows it is largely inert, so the real
      // protection is the user-profile ACL; that is reported, not pretended.
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath);
      await restrictPermissions(filePath);
      return null;
    } catch {
      await unlink(temporary).catch(() => undefined);
      return "vault_unavailable";
    }
  }

  async function restrictPermissions(target: string): Promise<void> {
    try {
      await chmod(target, 0o600);
    } catch {
      // Report rather than swallow: a caller should know the file is only as
      // protected as the directory it lives in.
      permissionWarned = true;
    }
  }

  return {
    filePath,
    permissionWarning: () => permissionWarned,
    async readProviderProtection() {
      const loaded = await loadAll();
      if (!loaded.ok) return loaded;
      return {
        ok: true,
        value: {
          keys: [
            ...loaded.file.entries
              .filter((entry) => entry.purpose === "provider_api_key")
              .map((entry) => ({
                keyId: `${entry.reference}:${entry.revision}`,
                value: entry.secret,
                revision: entry.revision,
                state: "sending" as const,
              })),
            ...(loaded.file.retiredProviderKeys ?? []).map((entry) => ({
              keyId: `${entry.reference}:${entry.revision}`,
              value: entry.secret,
              revision: entry.revision,
              state: "retired" as const,
            })),
          ],
        },
      };
    },

    async read(reference: CredentialReference): Promise<CredentialResult<string>> {
      const invalid = validateReference(reference.reference);
      if (invalid !== null) return { ok: false, code: invalid };
      if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
        return { ok: false, code: "invalid_reference" };
      }
      const loaded = await loadAll();
      if (!loaded.ok) return { ok: false, code: loaded.code };

      const entry = loaded.file.entries.find(
        (candidate) =>
          candidate.reference === reference.reference && candidate.purpose === reference.purpose,
      );
      if (entry === undefined) return { ok: false, code: "not_found" };
      // A purpose mismatch is a different error than "missing": the reference
      // exists but was never granted this authority.
      if (entry.purpose !== reference.purpose) return { ok: false, code: "purpose_mismatch" };
      if (entry.secret.length === 0) return { ok: false, code: "empty_secret" };
      return { ok: true, value: entry.secret };
    },

    async write(input): Promise<CredentialResult<CredentialReference>> {
      const invalid = validateReference(input.reference);
      if (invalid !== null) return { ok: false, code: invalid };
      if (input.secret.length === 0) return { ok: false, code: "empty_secret" };
      if (Buffer.byteLength(input.secret, "utf8") > CREDENTIAL_LIMITS.maxSecretBytes) {
        return { ok: false, code: "invalid_reference" };
      }

      const loaded = await loadAll();
      if (!loaded.ok) return { ok: false, code: loaded.code };

      const existing = loaded.file.entries.find(
        (entry) => entry.reference === input.reference && entry.purpose === input.purpose,
      );
      // A reference name is fixed to one purpose. Reusing the name for another
      // purpose would let a search key answer a Provider lookup.
      if (
        loaded.file.entries.some(
          (entry) => entry.reference === input.reference && entry.purpose !== input.purpose,
        )
      ) {
        return { ok: false, code: "purpose_mismatch" };
      }

      const retiredProviderKeys = [...(loaded.file.retiredProviderKeys ?? [])];
      if (existing?.purpose === "provider_api_key") retiredProviderKeys.push(existing);
      const revision =
        Math.max(
          existing?.revision ?? 0,
          ...retiredProviderKeys
            .filter((entry) => entry.reference === input.reference)
            .map((entry) => entry.revision),
        ) + 1;
      const next: StoredEntry = {
        purpose: input.purpose,
        reference: input.reference,
        revision,
        secret: input.secret,
        updatedAtUtc: now(),
      };
      const entries = loaded.file.entries.filter(
        (entry) => !(entry.reference === input.reference && entry.purpose === input.purpose),
      );
      const failure = await persist({
        schemaVersion: 1,
        entries: [...entries, next],
        retiredProviderKeys,
      });
      if (failure !== null) return { ok: false, code: failure };
      return { ok: true, value: { reference: input.reference, purpose: input.purpose, revision } };
    },

    async remove(reference: string): Promise<CredentialResult<null>> {
      const invalid = validateReference(reference);
      if (invalid !== null) return { ok: false, code: invalid };
      const loaded = await loadAll();
      if (!loaded.ok) return { ok: false, code: loaded.code };

      const entries = loaded.file.entries.filter((entry) => entry.reference !== reference);
      if (entries.length === loaded.file.entries.length) {
        return { ok: false, code: "not_found" };
      }
      const retiredProviderKeys = [
        ...(loaded.file.retiredProviderKeys ?? []),
        ...loaded.file.entries.filter(
          (entry) => entry.reference === reference && entry.purpose === "provider_api_key",
        ),
      ];
      const failure = await persist({ schemaVersion: 1, entries, retiredProviderKeys });
      if (failure !== null) return { ok: false, code: failure };
      return { ok: true, value: null };
    },
  };
}

function parseStoredFile(value: unknown): StoredFile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) return null;
  const entries = record["entries"];
  if (!Array.isArray(entries)) return null;

  const parsed: StoredEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    const purpose = item["purpose"];
    if (purpose !== "provider_api_key" && purpose !== "search_api_key") return null;
    if (typeof item["reference"] !== "string") return null;
    if (typeof item["secret"] !== "string") return null;
    if (typeof item["updatedAtUtc"] !== "string") return null;
    if (!Number.isSafeInteger(item["revision"]) || (item["revision"] as number) < 1) return null;
    parsed.push({
      purpose,
      reference: item["reference"],
      revision: item["revision"] as number,
      secret: item["secret"],
      updatedAtUtc: item["updatedAtUtc"],
    });
  }
  const retired = record["retiredProviderKeys"];
  if (retired !== undefined && !Array.isArray(retired)) return null;
  const retiredParsed: StoredEntry[] = [];
  for (const entry of retired ?? []) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (
      item["purpose"] !== "provider_api_key" ||
      typeof item["reference"] !== "string" ||
      typeof item["secret"] !== "string" ||
      item["secret"].length === 0 ||
      typeof item["updatedAtUtc"] !== "string" ||
      !Number.isSafeInteger(item["revision"]) ||
      (item["revision"] as number) < 1
    )
      return null;
    retiredParsed.push({
      purpose: "provider_api_key",
      reference: item["reference"],
      revision: item["revision"] as number,
      secret: item["secret"],
      updatedAtUtc: item["updatedAtUtc"],
    });
  }
  if (parsed.some((entry) => entry.secret.length === 0)) return null;
  return { schemaVersion: 1, entries: parsed, retiredProviderKeys: retiredParsed };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
