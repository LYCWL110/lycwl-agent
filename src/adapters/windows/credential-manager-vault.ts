import koffi from "koffi";

import {
  CREDENTIAL_LIMITS,
  type CredentialFailure,
  type CredentialPurpose,
  type CredentialReference,
  type CredentialResult,
  type CredentialVault,
  validateReference,
} from "../../ports/credential-vault.ts";
import {
  CRED_PERSIST_LOCAL_MACHINE,
  CRED_TYPE_GENERIC,
  CredDeleteW,
  CredentialW,
  CredFree,
  CredReadW,
  CredWriteW,
  ERROR_NOT_FOUND,
  GetLastError,
  readBlob,
} from "./credential-manager-bindings.ts";

/**
 * Windows Credential Manager vault (G03 / ADR-0023).
 *
 * The confirmed route: Koffi -> CredReadW / CredWriteW / CredDeleteW / CredFree,
 * generic credentials, local-machine persistence, same Windows user.
 *
 * Honest limits, stated once:
 * - this is not protection against another process running as the same user;
 * - a value that was read is in this process's memory, so the owned-key exit
 *   guard still has to keep it out of model context and diagnostics;
 * - deletion removes sending authority; it does not claim historical protective
 *   copies were erased.
 *
 * The purpose check lives in `reserveReference`: a search secret cannot
 * authenticate a Provider, even if the caller supplies the right reference name.
 */

/** Prefix per purpose so a vault target cannot be reused across purposes. */
const PURPOSE_PREFIX: Readonly<Record<CredentialPurpose, string>> = {
  provider_api_key: "lycwl/provider/",
  search_api_key: "lycwl/search/",
};

export const CREDENTIAL_MANAGER_NOT_VALIDATED = "gate_not_validated";

export type CredentialManagerOptions = Readonly<{
  /**
   * G03 gate. Real vault access is refused unless the caller has explicitly
   * recorded that the gate was validated on this host.
   */
  gateValidated: boolean;
}>;

export function credentialTargetName(purpose: CredentialPurpose, reference: string): string {
  return `${PURPOSE_PREFIX[purpose]}${reference}`;
}

export function createCredentialManagerVault(options: CredentialManagerOptions): CredentialVault {
  return {
    async read(reference: CredentialReference): Promise<CredentialResult<string>> {
      if (!options.gateValidated) return fail(CREDENTIAL_MANAGER_NOT_VALIDATED);
      const checked = checkReference(reference);
      if (checked !== null) return fail(checked);

      const target = credentialTargetName(reference.purpose, reference.reference);
      let pointer: unknown[] = [];
      try {
        const ok = CredReadW(target, CRED_TYPE_GENERIC, 0, pointer);
        if (!ok) {
          const code = GetLastError();
          return fail(code === ERROR_NOT_FOUND ? "not_found" : "vault_unavailable");
        }
        const handle = pointer[0];
        if (handle === null || handle === undefined) return fail("vault_unavailable");
        try {
          const decoded = koffi.decode(handle, CredentialW) as { CredentialBlobSize: number };
          if (decoded.CredentialBlobSize > CREDENTIAL_LIMITS.maxSecretBytes) {
            return fail("vault_unavailable");
          }
          const secret = readBlob(koffi.decode(handle, CredentialW));
          if (secret.length === 0) return fail("empty_secret");
          return { ok: true, value: secret };
        } finally {
          CredFree(handle);
        }
      } catch {
        return fail("vault_unavailable");
      } finally {
        pointer = [];
      }
    },

    async write(input): Promise<CredentialResult<CredentialReference>> {
      if (!options.gateValidated) return fail(CREDENTIAL_MANAGER_NOT_VALIDATED);
      const referenceFailure = validateReference(input.reference);
      if (referenceFailure !== null) return fail(referenceFailure);
      if (input.secret.length === 0) return fail("empty_secret");

      const bytes = Buffer.from(input.secret, "utf16le");
      if (bytes.length > CREDENTIAL_LIMITS.maxSecretBytes) return fail("invalid_reference");

      const target = credentialTargetName(input.purpose, input.reference);
      try {
        const credential = {
          Flags: 0,
          Type: CRED_TYPE_GENERIC,
          TargetName: target,
          Comment: null,
          LastWrittenLow: 0,
          LastWrittenHigh: 0,
          CredentialBlobSize: bytes.length,
          CredentialBlob: bytes,
          Persist: CRED_PERSIST_LOCAL_MACHINE,
          AttributeCount: 0,
          Attributes: null,
          TargetAlias: null,
          UserName: null,
        };
        const ok = CredWriteW(credential, 0);
        if (!ok) return fail("vault_unavailable");
        return {
          ok: true,
          value: { reference: input.reference, purpose: input.purpose, revision: 1 },
        };
      } catch {
        return fail("vault_unavailable");
      }
    },

    async remove(reference: string): Promise<CredentialResult<null>> {
      if (!options.gateValidated) return fail(CREDENTIAL_MANAGER_NOT_VALIDATED);
      const invalid = validateReference(reference);
      if (invalid !== null) return fail(invalid);
      // Removal is purpose-scoped in the target name, so both prefixes are tried
      // without guessing which one held the value.
      let removed = false;
      for (const purpose of ["provider_api_key", "search_api_key"] as const) {
        const target = credentialTargetName(purpose, reference);
        try {
          if (CredDeleteW(target, CRED_TYPE_GENERIC, 0)) removed = true;
        } catch {
          return fail("vault_unavailable");
        }
      }
      return removed ? { ok: true, value: null } : fail("not_found");
    },
  };
}

function checkReference(reference: CredentialReference): CredentialFailure | null {
  const invalid = validateReference(reference.reference);
  if (invalid !== null) return invalid;
  if (reference.revision < 1 || !Number.isSafeInteger(reference.revision)) {
    return "invalid_reference";
  }
  return null;
}

function fail(code: string): { ok: false; code: CredentialFailure } {
  return { ok: false, code: code as CredentialFailure };
}
