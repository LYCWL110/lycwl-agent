import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SEARCH_CREDENTIAL_REFERENCE, storeSearchKey } from "../../src/bootstrap/search-key.ts";
import type {
  CredentialFailure,
  CredentialReference,
  CredentialResult,
} from "../../src/ports/credential-vault.ts";

function vault(failure: CredentialFailure | null = null) {
  const writes: { reference: string; purpose: string; secret: string }[] = [];
  return {
    writes,
    async write(input: {
      reference: string;
      purpose: "provider_api_key" | "search_api_key";
      secret: string;
    }): Promise<CredentialResult<CredentialReference>> {
      writes.push(input);
      if (failure !== null) return { ok: false, code: failure };
      return {
        ok: true,
        value: { reference: input.reference, purpose: input.purpose, revision: 1 },
      };
    },
  };
}

describe("search key storage", () => {
  it("writes the trimmed key under the purpose-bound reference", async () => {
    const fake = vault();
    const messages: string[] = [];
    const result = await storeSearchKey({
      vault: fake,
      ask: async () => "  tvly-test-key\n",
      write: (text) => messages.push(text),
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(fake.writes, [
      {
        reference: SEARCH_CREDENTIAL_REFERENCE,
        purpose: "search_api_key",
        secret: "tvly-test-key",
      },
    ]);
    assert.equal(messages.join("").includes("tvly-test-key"), false);
  });

  it("does not write an empty answer", async () => {
    const fake = vault();
    const result = await storeSearchKey({
      vault: fake,
      ask: async () => "   ",
      write: () => undefined,
    });

    assert.deepEqual(result, { ok: false, code: "empty" });
    assert.equal(fake.writes.length, 0);
  });

  it("does not write when the prompt is cancelled", async () => {
    const fake = vault();
    const result = await storeSearchKey({
      vault: fake,
      ask: async () => null,
      write: () => undefined,
    });

    assert.deepEqual(result, { ok: false, code: "cancelled" });
    assert.equal(fake.writes.length, 0);
  });

  it("reports a vault failure without echoing the key", async () => {
    const fake = vault("vault_unavailable");
    const messages: string[] = [];
    const result = await storeSearchKey({
      vault: fake,
      ask: async () => "tvly-secret",
      write: (text) => messages.push(text),
    });

    assert.deepEqual(result, {
      ok: false,
      code: "vault_failure",
      detail: "vault_unavailable",
    });
    assert.equal(messages.join("").includes("tvly-secret"), false);
  });
});
