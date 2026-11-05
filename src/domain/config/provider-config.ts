/**
 * Provider configuration (C03 + S02 first-time setup).
 *
 * This is the model behind the TUI setup screen: which provider, protocol,
 * endpoint, model and credential reference a Run will use. It decides nothing
 * about network access or credentials 閳?it validates a draft and produces the
 * values the composition root needs.
 *
 * Deliberately narrow: one protocol is implemented, so the model rejects any other
 * protocol instead of accepting a value nothing can serve.
 */

export const SUPPORTED_PROTOCOLS = ["anthropic_messages"] as const;
export type SupportedProtocol = (typeof SUPPORTED_PROTOCOLS)[number];

export const PROVIDER_CONFIG_LIMITS = Object.freeze({
  maxModelLength: 200,
  maxBaseUrlLength: 2_048,
  maxCredentialRefLength: 128,
  defaultMaxOutputTokens: 4_096,
});

export type ProviderConfig = Readonly<{
  protocol: SupportedProtocol;
  /** Base URL without the protocol-specific path, e.g. `https://api.anthropic.com`. */
  baseUrl: string;
  model: string;
  /** Vault reference, never the key itself. */
  credentialRef: string;
  maxOutputTokens: number;
  /**
   * Verified context window, or null when the user did not supply one. A null
   * window disables budgeting and compaction rather than substituting a guess:
   * C04 says an unknown window is model_context_unknown.
   */
  contextWindow: number | null;
}>;

export type ProviderConfigFailure =
  | "invalid_protocol"
  | "unsupported_protocol"
  | "invalid_base_url"
  | "insecure_base_url"
  | "invalid_model"
  | "invalid_credential_ref"
  | "invalid_output_tokens"
  | "invalid_context_window"
  | "missing_field";

export type ProviderConfigResult =
  | Readonly<{ ok: true; value: ProviderConfig }>
  | Readonly<{ ok: false; code: ProviderConfigFailure; field?: string }>;

/** Where the request actually goes, given the protocol. */
export function messagesEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}

/**
 * Validate a draft.
 *
 * A plaintext `http` endpoint is refused. Unlike WebFetch, there is no user
 * confirmation step on this path that could make an unencrypted credential
 * transmission acceptable, and the adapter itself refuses it too.
 */
export function validateProviderConfig(input: {
  protocol: unknown;
  baseUrl: unknown;
  model: unknown;
  credentialRef: unknown;
  maxOutputTokens?: unknown;
  contextWindow?: unknown;
}): ProviderConfigResult {
  if (typeof input.protocol !== "string" || input.protocol.length === 0) {
    return { ok: false, code: "invalid_protocol", field: "protocol" };
  }
  if (!(SUPPORTED_PROTOCOLS as readonly string[]).includes(input.protocol)) {
    // Not "unknown protocol": this build genuinely cannot serve it.
    return { ok: false, code: "unsupported_protocol", field: "protocol" };
  }

  if (typeof input.baseUrl !== "string" || input.baseUrl.length === 0) {
    return { ok: false, code: "missing_field", field: "baseUrl" };
  }
  if (input.baseUrl.length > PROVIDER_CONFIG_LIMITS.maxBaseUrlLength) {
    return { ok: false, code: "invalid_base_url", field: "baseUrl" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    return { ok: false, code: "invalid_base_url", field: "baseUrl" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "insecure_base_url", field: "baseUrl" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, code: "invalid_base_url", field: "baseUrl" };
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    // A query or fragment on a base URL would be dropped when the path is
    // appended, so accepting it would silently send a different endpoint.
    return { ok: false, code: "invalid_base_url", field: "baseUrl" };
  }

  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    return { ok: false, code: "invalid_model", field: "model" };
  }
  if (input.model.length > PROVIDER_CONFIG_LIMITS.maxModelLength) {
    return { ok: false, code: "invalid_model", field: "model" };
  }

  if (typeof input.credentialRef !== "string" || input.credentialRef.length === 0) {
    return { ok: false, code: "missing_field", field: "credentialRef" };
  }
  if (
    input.credentialRef.length > PROVIDER_CONFIG_LIMITS.maxCredentialRefLength ||
    !/^[\x21-\x7e]+$/.test(input.credentialRef)
  ) {
    return { ok: false, code: "invalid_credential_ref", field: "credentialRef" };
  }

  // A context window is optional. When absent, budgeting and compaction are
  // skipped entirely: C04 says an unknown window is `model_context_unknown`, and
  // guessing one would produce a budget the model does not actually have.
  const rawWindow = input.contextWindow;
  let contextWindow: number | null = null;
  if (rawWindow !== undefined) {
    if (
      typeof rawWindow !== "number" ||
      !Number.isSafeInteger(rawWindow) ||
      rawWindow < 8_192 ||
      rawWindow > 4_000_000
    ) {
      return { ok: false, code: "invalid_context_window", field: "contextWindow" };
    }
    contextWindow = rawWindow;
  }

  const rawTokens = input.maxOutputTokens;
  const maxOutputTokens =
    rawTokens === undefined ? PROVIDER_CONFIG_LIMITS.defaultMaxOutputTokens : rawTokens;
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 64_000
  ) {
    return { ok: false, code: "invalid_output_tokens", field: "maxOutputTokens" };
  }

  return {
    ok: true,
    value: {
      protocol: input.protocol as SupportedProtocol,
      baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ""),
      model: input.model.trim(),
      credentialRef: input.credentialRef,
      maxOutputTokens,
      contextWindow,
    },
  };
}

/**
 * Read a ProviderConfig out of a parsed settings document.
 *
 * Returns a typed failure rather than throwing, so the TUI can show a specific
 * message and the entry point can fall back to the demo instead of crashing.
 */
export function readProviderConfig(settings: unknown): ProviderConfigResult {
  if (typeof settings !== "object" || settings === null) {
    return { ok: false, code: "missing_field", field: "provider" };
  }
  const provider = (settings as Record<string, unknown>)["provider"];
  if (typeof provider !== "object" || provider === null) {
    return { ok: false, code: "missing_field", field: "provider" };
  }
  const record = provider as Record<string, unknown>;
  return validateProviderConfig({
    protocol: record["protocol"],
    baseUrl: record["baseUrl"],
    model: record["model"],
    credentialRef: record["credentialRef"],
    maxOutputTokens: record["maxOutputTokens"],
  });
}

/** Mask a secret for display: never show any character of it. */
export function maskSecret(value: string): string {
  if (value.length === 0) return "(empty)";
  // A fixed-width mask, not a length hint: surviving characters could be the only
  // distinguishing part of a short key.
  return "********";
}
