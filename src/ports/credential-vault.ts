/**
 * Credential boundary (C10 / ADR-0002 / ADR-0023).
 *
 * Secrets live only in Windows Credential Manager. Configuration, events, logs,
 * attachments and previews carry a reference and a revision, never a value.
 *
 * The purpose field is enforced here, not inferred from a name prefix: a search
 * credential cannot be borrowed to authenticate a model Provider, and vice
 * versa. Validating the purpose is what stops a reference from silently gaining
 * authority it was never granted.
 */

export type CredentialPurpose = "provider_api_key" | "search_api_key";

export type CredentialReference = Readonly<{
  /** Vault target name. Never contains the secret value. */
  reference: string;
  purpose: CredentialPurpose;
  revision: number;
}>;

export type CredentialFailure =
  | "invalid_reference"
  | "purpose_mismatch"
  | "not_found"
  | "vault_unavailable"
  | "empty_secret"
  /** G03 has not been validated on this host, so real vault access is refused. */
  | "gate_not_validated";

export type CredentialResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: CredentialFailure }>;

export const CREDENTIAL_LIMITS = Object.freeze({
  maxReferenceLength: 128,
  maxSecretBytes: 4_096,
});

/** Reference names are app-scoped and printable; they are not secrets. */
export function validateReference(reference: string): CredentialFailure | null {
  if (reference.length === 0) return "invalid_reference";
  if (reference.length > CREDENTIAL_LIMITS.maxReferenceLength) return "invalid_reference";
  for (const character of reference) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      return "invalid_reference";
    }
  }
  return null;
}

/**
 * The vault port. Implementations must never log, return or copy a secret value
 * anywhere except the single caller that asked for it.
 */
export interface CredentialVault {
  /** Read a secret for a reference whose purpose must match. */
  read(reference: CredentialReference): Promise<CredentialResult<string>>;
  /** Store or replace a secret, returning the new revision. */
  write(input: {
    reference: string;
    purpose: CredentialPurpose;
    secret: string;
  }): Promise<CredentialResult<CredentialReference>>;
  /** Remove a value. This removes sending authority, not historical copies. */
  remove(reference: string): Promise<CredentialResult<null>>;
}

/**
 * A resolver used at the point of use, so a rotation is honoured by the next
 * attempt rather than being frozen at composition time. Returns null when no
 * credential is configured; callers must treat that as "do not send".
 */
export type CredentialResolver = () => Promise<string | null>;
