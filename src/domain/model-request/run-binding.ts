/**
 * Per-Run model binding (C03 / ADR-0008).
 *
 * A Run's route is fixed when the Run starts. Changing provider, model, protocol,
 * endpoint, adapter or capability snapshot selects the **next** Run; it never
 * hot-switches the current one. The credential reference and revision are bound
 * per attempt, so same-provider rotation applies to the next not-yet-sent attempt
 * while an in-flight request keeps the revision it was sent with.
 *
 * Nothing here holds a secret value. The binding records a reference and a
 * revision only, and an endpoint fingerprint rather than a full URL, so it can be
 * persisted in events without leaking credentials or private paths.
 */

export const RUN_BINDING_LIMITS = Object.freeze({
  maxIdLength: 128,
  maxFingerprintInputBytes: 2_048,
});

export type RunBindingFailure =
  | "invalid_provider_id"
  | "invalid_model_id"
  | "invalid_protocol_id"
  | "invalid_adapter_version"
  | "invalid_endpoint"
  | "invalid_fingerprint"
  | "invalid_snapshot"
  | "invalid_credential_reference"
  | "invalid_credential_revision";

export type EndpointDescriptor = Readonly<{
  scheme: "https";
  /** Lowercased hostname. No userinfo, no port tricks, no path traversal. */
  host: string;
  /** Null for the scheme default. */
  port: number | null;
  /** Always begins with `/`. Query and fragment are excluded by design. */
  path: string;
}>;

export type SnapshotIdentity = Readonly<{
  snapshotId: string;
  sha256: string;
}>;

export type CredentialBinding = Readonly<{
  /** Vault target reference. Never the secret. */
  credentialRef: string;
  revision: number;
}>;

export type RunModelBinding = Readonly<{
  providerId: string;
  modelId: string;
  protocolId: string;
  adapterVersion: string;
  endpoint: EndpointDescriptor;
  /** Sanitized fingerprint of `endpoint`; not the C03 request fingerprint. */
  endpointFingerprint: string;
  catalog: SnapshotIdentity;
  capabilities: SnapshotIdentity;
  /**
   * Credential identity as first bound. Attempts may advance the revision, but a
   * change of account identity is a re-consent boundary, not a silent rebind.
   */
  credential: CredentialBinding;
}>;

export type RunBindingResult =
  | Readonly<{ ok: true; value: RunModelBinding }>
  | Readonly<{ ok: false; code: RunBindingFailure }>;

export type EndpointResult =
  | Readonly<{ ok: true; value: EndpointDescriptor }>
  | Readonly<{ ok: false; code: "invalid_endpoint" }>;

/**
 * Describe an endpoint for fingerprinting.
 *
 * Deliberately lossy: only scheme, host, port and path survive. Query strings and
 * fragments frequently carry API keys or tenant identifiers, and userinfo is
 * never legal here. Losing them means two endpoints that differ only by query
 * share a fingerprint; that is the intended trade, because the alternative is
 * persisting secrets in an event.
 */
export function describeEndpoint(input: {
  host: string;
  port: number | null;
  path: string;
}): EndpointResult {
  const host = input.host.trim().toLowerCase();
  if (host.length === 0) return { ok: false, code: "invalid_endpoint" };
  if (host.includes("@") || host.includes("/") || host.includes("?") || host.includes("#")) {
    return { ok: false, code: "invalid_endpoint" };
  }
  if (input.port !== null) {
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
      return { ok: false, code: "invalid_endpoint" };
    }
  }
  const rawPath = input.path.length === 0 ? "/" : input.path;
  if (!rawPath.startsWith("/")) return { ok: false, code: "invalid_endpoint" };
  if (rawPath.includes("?") || rawPath.includes("#")) {
    return { ok: false, code: "invalid_endpoint" };
  }
  if (rawPath.includes("\u0000")) return { ok: false, code: "invalid_endpoint" };

  return {
    ok: true,
    value: { scheme: "https", host, port: input.port, path: rawPath },
  };
}

/**
 * Canonical string fed to the injected hash. Stable across platforms and free of
 * any value that could carry a credential.
 */
export function endpointFingerprintInput(endpoint: EndpointDescriptor): string {
  return [
    endpoint.scheme,
    endpoint.host,
    endpoint.port === null ? "" : String(endpoint.port),
    endpoint.path,
  ].join("\u0000");
}

export function createRunModelBinding(input: {
  providerId: string;
  modelId: string;
  protocolId: string;
  adapterVersion: string;
  endpoint: EndpointDescriptor;
  endpointFingerprint: string;
  catalog: SnapshotIdentity;
  capabilities: SnapshotIdentity;
  credential: CredentialBinding;
}): RunBindingResult {
  const idFailure =
    checkId(input.providerId, "invalid_provider_id") ??
    checkId(input.modelId, "invalid_model_id") ??
    checkId(input.protocolId, "invalid_protocol_id");
  if (idFailure !== null) return { ok: false, code: idFailure };

  if (
    input.adapterVersion.length === 0 ||
    input.adapterVersion.length > RUN_BINDING_LIMITS.maxIdLength
  ) {
    return { ok: false, code: "invalid_adapter_version" };
  }
  if (!isHex64(input.endpointFingerprint)) {
    return { ok: false, code: "invalid_fingerprint" };
  }
  const snapshotFailure = checkSnapshot(input.catalog) ?? checkSnapshot(input.capabilities);
  if (snapshotFailure !== null) return { ok: false, code: "invalid_snapshot" };

  if (input.credential.credentialRef.length === 0) {
    return { ok: false, code: "invalid_credential_reference" };
  }
  if (!Number.isSafeInteger(input.credential.revision) || input.credential.revision < 1) {
    return { ok: false, code: "invalid_credential_revision" };
  }

  return {
    ok: true,
    value: {
      providerId: input.providerId,
      modelId: input.modelId,
      protocolId: input.protocolId,
      adapterVersion: input.adapterVersion,
      endpoint: input.endpoint,
      endpointFingerprint: input.endpointFingerprint,
      catalog: input.catalog,
      capabilities: input.capabilities,
      credential: input.credential,
    },
  };
}

export type AttemptBinding = Readonly<{
  modelRequestId: string;
  attemptNo: number;
  route: Readonly<{
    providerId: string;
    modelId: string;
    protocolId: string;
    adapterVersion: string;
    endpointFingerprint: string;
    catalogSnapshotId: string;
    capabilitySnapshotId: string;
  }>;
  credential: CredentialBinding;
}>;

export type AttemptBindingFailure =
  | "invalid_attempt_identity"
  | "route_changed"
  | "credential_identity_changed"
  | "invalid_credential_revision";

/**
 * Bind one attempt to the Run route and a credential revision.
 *
 * A revision advance for the same reference is allowed: that is a rotation, and
 * the next unsent attempt is exactly where it must take effect. A **different
 * reference** is a different credential identity, which cannot be adopted inside
 * a Run without re-satisfying disclosure consent.
 */
export function bindAttempt(
  binding: RunModelBinding,
  input: {
    modelRequestId: string;
    attemptNo: number;
    credential: CredentialBinding;
  },
):
  | Readonly<{ ok: true; value: AttemptBinding }>
  | Readonly<{ ok: false; code: AttemptBindingFailure }> {
  if (input.modelRequestId.length === 0) {
    return { ok: false, code: "invalid_attempt_identity" };
  }
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1) {
    return { ok: false, code: "invalid_attempt_identity" };
  }
  if (!Number.isSafeInteger(input.credential.revision) || input.credential.revision < 1) {
    return { ok: false, code: "invalid_credential_revision" };
  }
  if (input.credential.credentialRef !== binding.credential.credentialRef) {
    return { ok: false, code: "credential_identity_changed" };
  }

  return {
    ok: true,
    value: {
      modelRequestId: input.modelRequestId,
      attemptNo: input.attemptNo,
      route: {
        providerId: binding.providerId,
        modelId: binding.modelId,
        protocolId: binding.protocolId,
        adapterVersion: binding.adapterVersion,
        endpointFingerprint: binding.endpointFingerprint,
        catalogSnapshotId: binding.catalog.snapshotId,
        capabilitySnapshotId: binding.capabilities.snapshotId,
      },
      credential: input.credential,
    },
  };
}

/**
 * A destination plus credential identity that the user consented to disclose
 * sensitive material to. Recorded as a fact; it is not a permission grant for any
 * other destination or identity.
 */
export type DisclosureConsent = Readonly<{
  destination: Readonly<{
    providerId: string;
    modelId: string;
    endpointFingerprint: string;
  }>;
  credential: CredentialBinding;
  /** Sensitive sources the user saw and agreed to disclose. */
  coveredSourceIds: readonly string[];
}>;

export type DisclosureDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason:
        | "no_consent"
        | "destination_changed"
        | "credential_identity_changed"
        | "source_not_covered";
      /** Sources that would need to be shown and reapproved. */
      missingSourceIds: readonly string[];
    }>;

/**
 * Decide whether sensitive material may be sent under the current identity.
 *
 * The conservative reading of ADR-0008 is implemented: a change of credential
 * reference always requires fresh consent, because a different reference may
 * represent a different account even when the provider id is unchanged. A
 * revision advance for the same reference is a rotation of the same identity and
 * is not by itself a consent boundary; that limitation is recorded in the ADR.
 */
export function decideDisclosure(input: {
  consent: DisclosureConsent | null;
  binding: RunModelBinding;
  currentCredential: CredentialBinding;
  /** Sensitive source ids present in the request about to be sent. */
  requestedSourceIds: readonly string[];
}): DisclosureDecision {
  const { consent } = input;
  if (consent === null) {
    return {
      allowed: false,
      reason: "no_consent",
      missingSourceIds: [...input.requestedSourceIds].sort(),
    };
  }
  if (
    consent.destination.providerId !== input.binding.providerId ||
    consent.destination.modelId !== input.binding.modelId ||
    consent.destination.endpointFingerprint !== input.binding.endpointFingerprint
  ) {
    return {
      allowed: false,
      reason: "destination_changed",
      missingSourceIds: [...input.requestedSourceIds].sort(),
    };
  }
  if (consent.credential.credentialRef !== input.currentCredential.credentialRef) {
    return {
      allowed: false,
      reason: "credential_identity_changed",
      missingSourceIds: [...input.requestedSourceIds].sort(),
    };
  }

  const covered = new Set(consent.coveredSourceIds);
  const missing = input.requestedSourceIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: "source_not_covered",
      missingSourceIds: [...missing].sort(),
    };
  }
  return { allowed: true };
}

/**
 * The preview the user must see before consenting. No secret value appears, and
 * the covered material is listed by id so consent is bounded to what was shown.
 */
export function formatDisclosurePreview(input: {
  binding: RunModelBinding;
  credential: CredentialBinding;
  sourceIds: readonly string[];
}): string {
  return [
    "sensitive_disclosure",
    `provider=${input.binding.providerId}`,
    `model=${input.binding.modelId}`,
    `protocol=${input.binding.protocolId}`,
    `endpoint=${input.binding.endpoint.host}${input.binding.endpoint.port === null ? "" : `:${input.binding.endpoint.port}`}${input.binding.endpoint.path}`,
    `endpointFingerprint=${input.binding.endpointFingerprint.slice(0, 16)}`,
    `credentialRef=${input.credential.credentialRef}`,
    `credentialRevision=${input.credential.revision}`,
    `covers=${[...input.sourceIds].sort().join(",") || "(none)"}`,
    "effect=sensitive material above may be transmitted to this destination",
    "note=consent covers only the material shown; a change needs fresh agreement",
  ].join("\n");
}

function checkId(value: string, code: RunBindingFailure): RunBindingFailure | null {
  if (value.length === 0 || value.length > RUN_BINDING_LIMITS.maxIdLength) return code;
  return null;
}

function checkSnapshot(snapshot: SnapshotIdentity): RunBindingFailure | null {
  if (snapshot.snapshotId.length === 0) return "invalid_snapshot";
  if (!isHex64(snapshot.sha256)) return "invalid_snapshot";
  return null;
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
