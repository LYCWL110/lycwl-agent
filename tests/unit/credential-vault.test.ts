import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCredentialManagerVault,
  credentialTargetName,
} from "../../src/adapters/windows/credential-manager-vault.ts";
import {
  CREDENTIAL_LIMITS,
  type CredentialVault,
  validateReference,
} from "../../src/ports/credential-vault.ts";

/**
 * The vault is exercised through an in-memory stand-in so no real Credential
 * Manager entry is read, written or deleted. G03 remains unvalidated on this
 * host; the adapter refuses real access unless that gate is set explicitly.
 */

class MemoryVault implements CredentialVault {
  readonly #values = new Map<string, string>();

  async read(reference: { reference: string; purpose: string; revision: number }) {
    const value = this.#values.get(
      credentialTargetName(reference.purpose as "search_api_key", reference.reference),
    );
    return value === undefined
      ? ({ ok: false, code: "not_found" } as const)
      : ({ ok: true, value } as const);
  }

  async write(input: {
    reference: string;
    purpose: "provider_api_key" | "search_api_key";
    secret: string;
  }) {
    this.#values.set(credentialTargetName(input.purpose, input.reference), input.secret);
    return {
      ok: true as const,
      value: { reference: input.reference, purpose: input.purpose, revision: 1 },
    };
  }

  async remove(reference: string) {
    return this.#values.delete(credentialTargetName("search_api_key", reference))
      ? ({ ok: true, value: null } as const)
      : ({ ok: false, code: "not_found" } as const);
  }
}

describe("credential reference validation", () => {
  it("accepts a printable app-scoped reference", () => {
    assert.equal(validateReference("tavily-main"), null);
  });

  it("rejects empty, over-long and non-printable references", () => {
    assert.equal(validateReference(""), "invalid_reference");
    assert.equal(
      validateReference("a".repeat(CREDENTIAL_LIMITS.maxReferenceLength + 1)),
      "invalid_reference",
    );
    assert.equal(validateReference("has space"), "invalid_reference");
    assert.equal(validateReference("line\nbreak"), "invalid_reference");
    assert.equal(validateReference("中文"), "invalid_reference");
  });
});

describe("credential target names are purpose-scoped", () => {
  it("never lets a search and a provider reference collide", () => {
    const search = credentialTargetName("search_api_key", "main");
    const provider = credentialTargetName("provider_api_key", "main");
    assert.notEqual(search, provider);
    assert.match(search, /^lycwl\/search\//);
    assert.match(provider, /^lycwl\/provider\//);
  });
});

describe("vault round trip through a stand-in", () => {
  it("stores and reads a secret by purpose", async () => {
    const vault = new MemoryVault();
    const written = await vault.write({
      reference: "tavily-main",
      purpose: "search_api_key",
      secret: "tvly-secret",
    });
    assert.equal(written.ok, true);

    const read = await vault.read({
      reference: "tavily-main",
      purpose: "search_api_key",
      revision: 1,
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value, "tvly-secret");
  });

  it("reports not_found for an unknown reference", async () => {
    const vault = new MemoryVault();
    const read = await vault.read({
      reference: "absent",
      purpose: "search_api_key",
      revision: 1,
    });
    assert.deepEqual(read, { ok: false, code: "not_found" });
  });

  it("removes a value and then reports it missing", async () => {
    const vault = new MemoryVault();
    await vault.write({ reference: "gone", purpose: "search_api_key", secret: "x" });
    assert.equal((await vault.remove("gone")).ok, true);
    assert.deepEqual(
      await vault.read({ reference: "gone", purpose: "search_api_key", revision: 1 }),
      { ok: false, code: "not_found" },
    );
  });
});

describe("credential manager adapter refuses real access until G03 is validated", () => {
  it("refuses read, write and remove when the gate is not validated", async () => {
    const vault = createCredentialManagerVault({ gateValidated: false });

    assert.deepEqual(await vault.read({ reference: "x", purpose: "search_api_key", revision: 1 }), {
      ok: false,
      code: "gate_not_validated",
    });
    assert.deepEqual(
      await vault.write({ reference: "x", purpose: "search_api_key", secret: "s" }),
      { ok: false, code: "gate_not_validated" },
    );
    assert.deepEqual(await vault.remove("x"), { ok: false, code: "gate_not_validated" });
  });

  it("validates the reference shape before touching the vault", async () => {
    const vault = createCredentialManagerVault({ gateValidated: true });
    // An invalid reference must be rejected without a Win32 call. A rejected
    // reference is a policy failure, not a vault failure.
    const result = await vault.read({ reference: "", purpose: "search_api_key", revision: 1 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_reference");
  });
});
