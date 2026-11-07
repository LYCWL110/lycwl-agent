import {
  AnthropicProvider,
  type AnthropicToolDefinition,
} from "../adapters/providers/anthropic-provider.ts";
import { OpenAiChatProvider } from "../adapters/providers/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../adapters/providers/openai-responses-provider.ts";
import { providerHttpsPost } from "../adapters/providers/provider-http.ts";
import { createFileVault } from "../adapters/windows/file-credential-vault.ts";
import {
  type ProviderConfig,
  protocolEndpoint,
  readProviderConfig,
} from "../domain/config/provider-config.ts";
import type { OwnedKeyRegistry } from "../domain/security/owned-key-guard.ts";
import type { ModelProvider } from "../ports/model-provider.ts";
import {
  assertProtectedValue,
  ProtectedDeliveryError,
} from "../services/security/guarded-delivery.ts";

/**
 * Real runtime composition.
 *
 * This is the bridge between what the user configured and a Run: it reads the
 * settings document, resolves the credential through the vault at call time, and
 * builds the adapter.
 *
 * It performs no network request at construction. A missing or invalid
 * configuration returns a typed reason so the entry point can fall back
 * explicitly instead of starting a Run that cannot send.
 */

export type RuntimeAssemblyFailure =
  | "config_missing"
  | "config_unreadable"
  | "config_invalid"
  | "config_unsupported_version"
  | "provider_missing"
  | "credential_missing";

export type RuntimeAssembly =
  | Readonly<{
      ok: true;
      provider: ModelProvider;
      config: ProviderConfig;
      ownedKeys: OwnedKeyRegistry;
      refreshOwnedKeys: () => Promise<void>;
      /** Non-fatal notes worth showing, e.g. plaintext credential storage. */
      warnings: readonly string[];
    }>
  | Readonly<{ ok: false; code: RuntimeAssemblyFailure; detail?: string }>;

export type AssembleOptions = Readonly<{
  /** Parsed settings document, or null when no file exists. */
  settings: unknown;
  /** Application data directory; the vault lives inside it. */
  dataDirectory: string;
  /**
   * Tool schemas the model may call. Passed in rather than derived here, so the
   * catalog stays the single owner of descriptions and parameter shapes.
   */
  toolDefinitions: readonly AnthropicToolDefinition[];
  /** Injected for tests. */
  post?: ConstructorParameters<typeof AnthropicProvider>[0]["post"];
  /** Trust a specific CA; used only by tests against a local self-signed server. */
  trustedCaPem?: string;
}>;

/**
 * Build the Provider described by `settings`.
 *
 * The credential resolver reads from the vault on every call, so rotating the key
 * takes effect on the next attempt without rebuilding the Run.
 */
export async function assembleRuntime(options: AssembleOptions): Promise<RuntimeAssembly> {
  const parsed = readProviderConfig(options.settings);
  if (!parsed.ok) {
    if (parsed.code === "missing_field" && parsed.field === "provider") {
      return { ok: false, code: "provider_missing" };
    }
    return { ok: false, code: "config_invalid", detail: `${parsed.code}:${parsed.field ?? ""}` };
  }
  const config = parsed.value;

  const vault = createFileVault({ directory: options.dataDirectory });
  let protectedKeys: OwnedKeyRegistry["keys"] = [];
  const ownedKeys: OwnedKeyRegistry = {
    get keys() {
      return protectedKeys;
    },
  };
  const refreshOwnedKeys = async () => {
    const loaded = await vault.readProviderProtection();
    if (!loaded.ok) throw new ProtectedDeliveryError("guard_failure");
    // Retain every value seen by this runtime even if the vault is externally replaced.
    const byValue = new Map(protectedKeys.map((key) => [key.value, key]));
    for (const key of loaded.value.keys) {
      const utf16le = Buffer.from(key.value, "utf16le");
      const representations = new Set([
        key.value,
        JSON.stringify(key.value).slice(1, -1),
        encodeURIComponent(key.value),
        Buffer.from(key.value, "utf8").toString("base64"),
        Buffer.from(key.value, "utf8").toString("base64").replace(/=+$/, ""),
        Buffer.from(key.value, "utf8").toString("base64url"),
        Buffer.from(key.value, "utf8")
          .toString("base64url")
          .padEnd(Math.ceil(Buffer.byteLength(key.value, "utf8") / 3) * 4, "="),
        utf16le.toString("latin1"),
        Buffer.from(utf16le).swap16().toString("latin1"),
        `Bearer ${key.value}`,
      ]);
      for (const value of representations) byValue.set(value, { ...key, value });
    }
    protectedKeys = [...byValue.values()];
  };
  try {
    await refreshOwnedKeys();
  } catch {
    return { ok: false, code: "credential_missing", detail: "protection_unavailable" };
  }

  // Check the credential exists before handing back a Provider. Otherwise the
  // first attempt fails as "authentication" and looks like a wrong key rather
  // than a configuration that was never completed.
  const reference = {
    reference: config.credentialRef,
    purpose: "provider_api_key" as const,
    revision: 1,
  };
  const probe = await vault.read(reference);
  if (!probe.ok) {
    return {
      ok: false,
      code: "credential_missing",
      detail: `${config.credentialRef}:${probe.code}`,
    };
  }

  const warnings: string[] = [];
  if (vault.permissionWarning()) {
    warnings.push("credential file permissions could not be restricted on this platform");
  }
  warnings.push("credentials are stored unencrypted (ADR-0038)");

  // Resolve per call so a rotation applies without rebuilding the Run. A failure
  // becomes "not configured", never an empty secret.
  const resolveApiKey = async () => {
    await refreshOwnedKeys();
    const read = await vault.read(reference);
    if (read.ok && !ownedKeys.keys.some((key) => key.value === read.value))
      throw new ProtectedDeliveryError("guard_failure");
    return read.ok ? read.value : null;
  };
  const post: NonNullable<AssembleOptions["post"]> = async (request) => {
    await refreshOwnedKeys();
    // Authentication headers belong to the trusted adapter. Message/tool/schema
    // bodies do not, including escaped JSON strings and restored history.
    try {
      assertProtectedValue(ownedKeys, JSON.parse(request.bodyText));
      assertProtectedValue(ownedKeys, request.url);
    } catch (error) {
      if (error instanceof ProtectedDeliveryError) throw error;
      throw new ProtectedDeliveryError("guard_failure");
    }
    if (request.signal?.aborted) return { ok: false, code: "cancelled" };
    return (options.post ?? providerHttpsPost)(request);
  };

  const provider: ModelProvider =
    config.protocol === "openai_responses"
      ? new OpenAiResponsesProvider({
          resolveApiKey,
          model: config.model,
          baseUrl: config.baseUrl,
          maxOutputTokens: config.maxOutputTokens,
          ...(config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: config.reasoningEffort }),
          tools: options.toolDefinitions,
          post,
          ...(options.trustedCaPem === undefined ? {} : { trustedCaPem: options.trustedCaPem }),
        })
      : config.protocol === "openai_chat"
        ? new OpenAiChatProvider({
            resolveApiKey,
            model: config.model,
            baseUrl: config.baseUrl,
            maxTokens: config.maxOutputTokens,
            ...(config.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: config.reasoningEffort }),
            tools: options.toolDefinitions,
            post,
            ...(options.trustedCaPem === undefined ? {} : { trustedCaPem: options.trustedCaPem }),
          })
        : new AnthropicProvider({
            resolveApiKey,
            model: config.model,
            endpoint: protocolEndpoint(config.baseUrl, config.protocol),
            maxTokens: config.maxOutputTokens,
            tools: options.toolDefinitions,
            post,
            ...(options.trustedCaPem === undefined ? {} : { trustedCaPem: options.trustedCaPem }),
          });

  return { ok: true, provider, config, warnings, ownedKeys, refreshOwnedKeys };
}
