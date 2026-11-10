import { createHash } from "node:crypto";
import { AnthropicProvider, } from "../adapters/providers/anthropic-provider.js";
import { OpenAiChatProvider } from "../adapters/providers/openai-chat-provider.js";
import { OpenAiResponsesProvider } from "../adapters/providers/openai-responses-provider.js";
import { providerHttpsPost } from "../adapters/providers/provider-http.js";
import { createFileVault } from "../adapters/windows/file-credential-vault.js";
import { protocolEndpoint, readProviderConfig, } from "../domain/config/provider-config.js";
import { assertProtectedValue, ProtectedDeliveryError, } from "../services/security/guarded-delivery.js";
/**
 * Build the Provider described by `settings`.
 *
 * The credential resolver reads from the vault on every call, so rotating the key
 * takes effect on the next attempt without rebuilding the Run.
 */
export async function assembleRuntime(options) {
    const parsed = readProviderConfig(options.settings);
    if (!parsed.ok) {
        if (parsed.code === "missing_field" && parsed.field === "provider") {
            return { ok: false, code: "provider_missing" };
        }
        return { ok: false, code: "config_invalid", detail: `${parsed.code}:${parsed.field ?? ""}` };
    }
    const config = parsed.value;
    const outputTokens = config.contextWindow === null
        ? config.maxOutputTokens
        : Math.min(config.maxOutputTokens, Math.max(1024, Math.floor(0.2 * config.contextWindow)));
    const vault = createFileVault({ directory: options.dataDirectory });
    let protectedKeys = [];
    const ownedKeys = {
        get keys() {
            return protectedKeys;
        },
    };
    const refreshOwnedKeys = async () => {
        const loaded = await vault.readProviderProtection();
        if (!loaded.ok)
            throw new ProtectedDeliveryError("guard_failure");
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
            for (const value of representations) {
                const byteEncoding = byValue.get(value)?.byteEncoding;
                byValue.set(value, {
                    ...key,
                    value,
                    ...(byteEncoding === undefined ? {} : { byteEncoding }),
                });
            }
            for (const value of [
                utf16le.toString("latin1"),
                Buffer.from(utf16le).swap16().toString("latin1"),
            ])
                byValue.set(value, { ...key, value, byteEncoding: "latin1" });
        }
        protectedKeys = [...byValue.values()];
    };
    try {
        await refreshOwnedKeys();
    }
    catch {
        return { ok: false, code: "credential_missing", detail: "protection_unavailable" };
    }
    // Check the credential exists before handing back a Provider. Otherwise the
    // first attempt fails as "authentication" and looks like a wrong key rather
    // than a configuration that was never completed.
    const reference = {
        reference: config.credentialRef,
        purpose: "provider_api_key",
        revision: 1,
    };
    const probe = await vault.readCurrent(reference.reference, reference.purpose);
    if (!probe.ok) {
        return {
            ok: false,
            code: "credential_missing",
            detail: `${config.credentialRef}:${probe.code}`,
        };
    }
    const warnings = [];
    if (vault.permissionWarning()) {
        warnings.push("credential file permissions could not be restricted on this platform");
    }
    warnings.push("credentials are stored unencrypted (ADR-0038)");
    const hash = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    const endpoint = new URL(protocolEndpoint(config.baseUrl, config.protocol));
    const descriptor = {
        scheme: "https",
        host: endpoint.hostname,
        port: endpoint.port === "" ? null : Number(endpoint.port),
        path: endpoint.pathname,
    };
    const unknownSnapshot = {
        snapshotId: "user-configured-unverified",
        sha256: hash([config, options.toolDefinitions]),
    };
    const runBinding = {
        providerId: "user-configured",
        modelId: config.model,
        protocolId: config.protocol,
        adapterVersion: "internal-1",
        endpoint: descriptor,
        endpointFingerprint: hash(descriptor),
        catalog: unknownSnapshot,
        capabilities: unknownSnapshot,
        credential: { credentialRef: config.credentialRef, revision: probe.value.credential.revision },
    };
    let prepared = null;
    const resolveCredentialRevision = async () => {
        const current = await vault.readCurrent(reference.reference, reference.purpose);
        if (!current.ok) {
            prepared = null;
            throw new Error("credential_binding_failed");
        }
        prepared = current.value;
        return current.value.credential.revision;
    };
    // Resolve per call so a rotation applies without rebuilding the Run. A failure
    // becomes "not configured", never an empty secret.
    const resolveApiKey = async () => {
        await refreshOwnedKeys();
        const read = await vault.readCurrent(reference.reference, reference.purpose);
        if (read.ok && !ownedKeys.keys.some((key) => key.value === read.value.secret))
            throw new ProtectedDeliveryError("guard_failure");
        if (!read.ok)
            return null;
        if (prepared !== null &&
            (prepared.credential.revision !== read.value.credential.revision ||
                prepared.secret !== read.value.secret))
            return null;
        return read.value.secret;
    };
    const post = async (request) => {
        await refreshOwnedKeys();
        if (prepared !== null) {
            const current = await vault.readCurrent(reference.reference, reference.purpose);
            if (!current.ok ||
                current.value.credential.revision !== prepared.credential.revision ||
                current.value.secret !== prepared.secret)
                throw new ProtectedDeliveryError("guard_failure");
        }
        // Authentication headers belong to the trusted adapter. Message/tool/schema
        // bodies do not, including escaped JSON strings and restored history.
        try {
            assertProtectedValue(ownedKeys, JSON.parse(request.bodyText));
            assertProtectedValue(ownedKeys, request.url);
        }
        catch (error) {
            if (error instanceof ProtectedDeliveryError)
                throw error;
            throw new ProtectedDeliveryError("guard_failure");
        }
        if (request.signal?.aborted)
            return { ok: false, code: "cancelled" };
        return (options.post ?? providerHttpsPost)(request);
    };
    const provider = config.protocol === "openai_responses"
        ? new OpenAiResponsesProvider({
            resolveApiKey,
            model: config.model,
            baseUrl: config.baseUrl,
            maxOutputTokens: outputTokens,
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
                maxTokens: outputTokens,
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
                maxTokens: outputTokens,
                ...(config.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: config.reasoningEffort }),
                tools: options.toolDefinitions,
                post,
                ...(options.trustedCaPem === undefined ? {} : { trustedCaPem: options.trustedCaPem }),
            });
    return {
        ok: true,
        provider,
        config,
        warnings,
        ownedKeys,
        refreshOwnedKeys,
        runBinding,
        resolveCredentialRevision,
        requestFingerprint: async (value) => hash([config, options.toolDefinitions, value]),
    };
}
