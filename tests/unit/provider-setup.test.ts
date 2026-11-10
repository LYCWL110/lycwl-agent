import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import {
  maskSecret,
  messagesEndpoint,
  protocolEndpoint,
  REASONING_EFFORTS,
  readProviderConfig,
  validateProviderConfig,
} from "../../src/domain/config/provider-config.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-setup-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function settings(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? toPlainValue(parsed.value) : null;
}

describe("provider config validation", () => {
  const base = {
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    model: "claude-test",
    credentialRef: "provider-main",
  };

  it("accepts a valid draft", () => {
    const result = validateProviderConfig(base);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.maxOutputTokens, 4096);
  });

  it("rejects a protocol this build cannot serve", () => {
    // openai_chat is now supported; a protocol with no adapter must still fail.
    const result = validateProviderConfig({ ...base, protocol: "google_generate_content" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unsupported_protocol");
  });

  it("accepts openai_chat now that its adapter exists", () => {
    const result = validateProviderConfig({ ...base, protocol: "openai_chat" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.protocol, "openai_chat");
  });

  it("validates and reads reasoning effort without enabling it by default", () => {
    for (const reasoningEffort of REASONING_EFFORTS) {
      const result = readProviderConfig({
        provider: { ...base, protocol: "openai_responses", reasoningEffort },
      });
      assert.ok(result.ok);
      assert.equal(result.value.reasoningEffort, reasoningEffort);
    }
    for (const reasoningEffort of ["turbo", "", 10, null]) {
      const result = validateProviderConfig({ ...base, protocol: "openai_chat", reasoningEffort });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.field, "reasoningEffort");
    }
    for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"])
      assert.equal(validateProviderConfig({ ...base, reasoningEffort }).ok, true);
    for (const reasoningEffort of ["none", "minimal"])
      assert.equal(validateProviderConfig({ ...base, reasoningEffort }).ok, false);
    const defaults = validateProviderConfig(base);
    assert.ok(defaults.ok);
    assert.equal(defaults.value.reasoningEffort, undefined);
  });

  it("rejects a plaintext http endpoint", () => {
    const result = validateProviderConfig({ ...base, baseUrl: "http://api.example.com" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "insecure_base_url");
  });

  it("rejects a base URL with a query or fragment", () => {
    for (const baseUrl of ["https://api.example.com?x=1", "https://api.example.com#frag"]) {
      const result = validateProviderConfig({ ...base, baseUrl });
      assert.equal(result.ok, false, baseUrl);
      if (result.ok) return;
      assert.equal(result.code, "invalid_base_url");
    }
  });

  it("rejects userinfo in the endpoint", () => {
    const result = validateProviderConfig({
      ...base,
      baseUrl: "https://user:pass@api.example.com",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_base_url");
  });

  it("rejects an empty model", () => {
    const result = validateProviderConfig({ ...base, model: "   " });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_model");
  });

  it("rejects an out-of-range output budget", () => {
    for (const maxOutputTokens of [0, -1, 1.5, 100_000]) {
      const result = validateProviderConfig({ ...base, maxOutputTokens });
      assert.equal(result.ok, false, String(maxOutputTokens));
    }
  });

  it("appends the protocol path to the base URL", () => {
    assert.equal(
      messagesEndpoint("https://api.anthropic.com"),
      "https://api.anthropic.com/v1/messages",
    );
    assert.equal(
      messagesEndpoint("https://api.anthropic.com/"),
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("never reveals any character of a secret", () => {
    assert.equal(maskSecret("sk-ant-secret"), "********");
    assert.equal(maskSecret("a"), "********");
    assert.equal(maskSecret(""), "(empty)");
    // The mask must not leak the length either.
    assert.equal(maskSecret("a").length, maskSecret("aaaaaaaaaaaa").length);
  });

  it("reads a provider block out of a settings document", () => {
    const result = readProviderConfig({
      provider: {
        protocol: "anthropic_messages",
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        credentialRef: "provider-main",
      },
    });
    assert.equal(result.ok, true);
  });

  it("reports a missing provider block", () => {
    const result = readProviderConfig({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "missing_field");
    assert.equal(result.field, "provider");
  });
});

describe("setup save", () => {
  it("writes the credential and the settings document", async () => {
    const directory = path.join(root, "save-ok");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    const result = await saveSetup({
      draft: {
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        credentialRef: "provider-main",
        apiKey: "sk-test-secret",
      },
      vault,
      store,
    });

    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.equal(result.credentialWritten, true);

    // The credential is in the vault.
    const read = await vault.read({
      reference: result.config.credentialRef,
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value, "sk-test-secret");

    // The settings document references it and never contains the secret.
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(
      loaded.value.text.includes("sk-test-secret"),
      false,
      "settings must not hold the key",
    );

    const provider = readProviderConfig(settings(loaded.value.text));
    assert.equal(provider.ok, true);
    if (!provider.ok) return;
    assert.equal(provider.value.model, "claude-test");
    assert.equal(provider.value.credentialRef, result.config.credentialRef);
    assert.match(provider.value.credentialRef, /^provider-/u);
  });

  it("keeps existing comments in the settings document", async () => {
    const directory = path.join(root, "save-comments");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    // Seed a document with a comment through the store's own save path.
    const seed = await store.save({
      baseRevision: 0,
      baseDocumentHash: "",
      draft: `{
  // keep this note
  "schemaVersion": 1,
  "revision": 0
}
`,
    });
    assert.equal(seed.ok, true);

    const result = await saveSetup({
      draft: {
        baseUrl: "https://api.anthropic.com",
        model: "m",
        credentialRef: "provider-main",
        apiKey: "k",
      },
      vault,
      store,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;

    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.match(loaded.value.text, /keep this note/);
  });

  it("rejects an invalid draft without writing anything", async () => {
    const directory = path.join(root, "save-invalid");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    const result = await saveSetup({
      draft: { baseUrl: "http://insecure", model: "m", credentialRef: "r", apiKey: "k" },
      vault,
      store,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "validation_failed");
    assert.equal(result.field, "baseUrl");
    // Nothing reached disk.
    assert.deepEqual(await store.load(), { ok: false, code: "config_missing" });
  });

  it("requires a key when no credential exists for the reference", async () => {
    const directory = path.join(root, "save-nokey");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    const result = await saveSetup({
      draft: {
        baseUrl: "https://api.anthropic.com",
        model: "m",
        credentialRef: "fresh",
        apiKey: "",
      },
      vault,
      store,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "credential_write_failed");
    assert.equal(result.field, "apiKey");
  });

  it("allows an empty key when a credential already exists", async () => {
    const directory = path.join(root, "save-existing");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    await vault.write({ reference: "existing", purpose: "provider_api_key", secret: "old" });

    const result = await saveSetup({
      draft: {
        baseUrl: "https://api.anthropic.com",
        model: "m",
        credentialRef: "existing",
        apiKey: "",
      },
      vault,
      store,
    });

    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.equal(result.credentialWritten, false);
  });

  it("does not leave the secret in the settings on a second save", async () => {
    const directory = path.join(root, "save-twice");
    const vault = createFileVault({ directory });
    const store = createConfigStore({ directory });

    for (const model of ["first", "second"]) {
      const result = await saveSetup({
        draft: {
          baseUrl: "https://api.anthropic.com",
          model,
          credentialRef: "r",
          apiKey: "secret-value",
        },
        vault,
        store,
      });
      assert.equal(result.ok, true, result.ok ? "" : result.code);
    }

    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.value.text.includes("secret-value"), false);
    assert.match(loaded.value.text, /"second"/);
  });

  it("preserves the old effective key when the final configuration CAS fails", async () => {
    for (const code of ["config_conflict", "write_failed"] as const) {
      const directory = path.join(root, `save-final-${code}`);
      const vault = createFileVault({ directory });
      const store = createConfigStore({ directory });
      const draft = {
        baseUrl: "https://api.example.com",
        model: "m",
        credentialRef: "requested",
        apiKey: "old-synthetic",
      };
      const seed = await saveSetup({ draft, vault, store });
      assert.ok(seed.ok);
      const before = await store.load();
      const failed = await saveSetup({
        draft: { ...draft, credentialRef: seed.config.credentialRef, apiKey: "new-synthetic" },
        vault,
        store: { ...store, save: async () => ({ ok: false, code }) },
      });
      assert.equal(failed.ok, false);
      assert.deepEqual(await store.load(), before);
      assert.deepEqual(
        await vault.read({
          reference: seed.config.credentialRef,
          purpose: "provider_api_key",
          revision: 1,
        }),
        { ok: true, value: "old-synthetic" },
      );
    }
  });

  it("retains all concurrent vault writes from independent adapter instances", async () => {
    const directory = path.join(root, "vault-concurrent");
    const writes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createFileVault({ directory }).write({
          reference: `key-${index}`,
          purpose: "provider_api_key",
          secret: `synthetic-${index}`,
        }),
      ),
    );
    assert.ok(writes.every((result) => result.ok));
    const reopened = createFileVault({ directory });
    for (let index = 0; index < 12; index += 1) {
      assert.deepEqual(
        await reopened.read({
          reference: `key-${index}`,
          purpose: "provider_api_key",
          revision: 1,
        }),
        { ok: true, value: `synthetic-${index}` },
      );
    }
  });
});

describe("endpoint version segment", () => {
  it("does not duplicate /v1 when the base URL already ends with it", () => {
    // Providers commonly display a base URL that already includes the version,
    // and pasting that produced /v1/v1/messages and a 404.
    assert.equal(
      protocolEndpoint("https://api.example.com/v1", "anthropic_messages"),
      "https://api.example.com/v1/messages",
    );
    assert.equal(
      protocolEndpoint("https://api.example.com/v1", "openai_chat"),
      "https://api.example.com/v1/chat/completions",
    );
    assert.equal(
      protocolEndpoint("https://api.example.com/v1", "openai_responses"),
      "https://api.example.com/v1/responses",
    );
  });

  it("treats /v1beta the same way", () => {
    assert.equal(
      protocolEndpoint("https://api.example.com/v1beta", "anthropic_messages"),
      "https://api.example.com/v1/messages",
    );
  });

  it("adds the version when the base URL has none", () => {
    assert.equal(
      protocolEndpoint("https://api.example.com", "anthropic_messages"),
      "https://api.example.com/v1/messages",
    );
  });

  it("ignores a trailing slash", () => {
    assert.equal(
      protocolEndpoint("https://api.example.com/v1/", "anthropic_messages"),
      "https://api.example.com/v1/messages",
    );
    assert.equal(
      protocolEndpoint("https://api.example.com/", "anthropic_messages"),
      "https://api.example.com/v1/messages",
    );
  });

  it("keeps a non-version path prefix", () => {
    assert.equal(
      protocolEndpoint("https://gateway.example.com/openai", "openai_chat"),
      "https://gateway.example.com/openai/v1/chat/completions",
    );
  });
});
