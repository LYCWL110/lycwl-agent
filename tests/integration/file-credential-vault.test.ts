import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-vault-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

async function freshVault(name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  return { directory, vault: createFileVault({ directory }) };
}

const REF = { reference: "provider-main", purpose: "provider_api_key" as const, revision: 1 };

describe("file vault round trip", () => {
  it("writes and reads a secret by purpose", async () => {
    const { vault } = await freshVault("roundtrip");
    const written = await vault.write({
      reference: "provider-main",
      purpose: "provider_api_key",
      secret: "sk-test-secret",
    });
    assert.equal(written.ok, true);
    if (!written.ok) return;
    assert.equal(written.value.revision, 1);

    const read = await vault.read(REF);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value, "sk-test-secret");
  });

  it("increments the revision on rewrite", async () => {
    const { vault } = await freshVault("revision");
    await vault.write({ reference: "r", purpose: "provider_api_key", secret: "one" });
    const second = await vault.write({
      reference: "r",
      purpose: "provider_api_key",
      secret: "two",
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.revision, 2);

    const read = await vault.read({ ...REF, reference: "r", revision: 2 });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value, "two");
  });

  it("reports not_found for an unknown reference", async () => {
    const { vault } = await freshVault("missing");
    const read = await vault.read({ ...REF, reference: "absent" });
    assert.deepEqual(read, { ok: false, code: "not_found" });
  });

  it("refuses to reuse a reference name across purposes", async () => {
    const { vault } = await freshVault("purpose");
    await vault.write({ reference: "shared", purpose: "provider_api_key", secret: "p" });
    const clash = await vault.write({
      reference: "shared",
      purpose: "search_api_key",
      secret: "s",
    });
    assert.deepEqual(clash, { ok: false, code: "purpose_mismatch" });
  });

  it("does not return a search secret for a provider lookup", async () => {
    const { vault } = await freshVault("no-borrow");
    await vault.write({ reference: "search-main", purpose: "search_api_key", secret: "s" });
    const read = await vault.read({
      reference: "search-main",
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.code, "purpose_mismatch");
  });

  it("rejects an empty secret on write", async () => {
    const { vault } = await freshVault("empty");
    const result = await vault.write({ reference: "r", purpose: "provider_api_key", secret: "" });
    assert.deepEqual(result, { ok: false, code: "empty_secret" });
  });

  it("rejects an invalid reference name", async () => {
    const { vault } = await freshVault("invalid-ref");
    const result = await vault.write({
      reference: "has space",
      purpose: "provider_api_key",
      secret: "x",
    });
    assert.deepEqual(result, { ok: false, code: "invalid_reference" });
  });

  it("removes a value and then reports it missing", async () => {
    const { vault } = await freshVault("remove");
    await vault.write({ reference: "gone", purpose: "provider_api_key", secret: "x" });
    assert.equal((await vault.remove("gone")).ok, true);
    assert.deepEqual(await vault.read({ ...REF, reference: "gone" }), {
      ok: false,
      code: "not_found",
    });
  });

  it("reports not_found when removing an unknown reference", async () => {
    const { vault } = await freshVault("remove-missing");
    assert.deepEqual(await vault.remove("absent"), { ok: false, code: "not_found" });
  });

  it("persists across vault instances", async () => {
    const { directory, vault } = await freshVault("persist");
    await vault.write({ reference: "persisted", purpose: "provider_api_key", secret: "value" });

    const reopened = createFileVault({ directory });
    const read = await reopened.read({
      reference: "persisted",
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.equal(read.ok, true, read.ok ? "" : read.code);
    if (!read.ok) return;
    assert.equal(read.value, "value");
  });
});

describe("file vault failure handling", () => {
  it("treats a corrupt file as unavailable rather than empty", async () => {
    const { directory, vault } = await freshVault("corrupt");
    await writeFile(path.join(directory, "credentials.json"), "not json", "utf8");

    // This is the important case: a corrupt file must not look like "no keys
    // configured", because that would silently drop every stored credential.
    assert.deepEqual(await vault.read(REF), { ok: false, code: "vault_unavailable" });
    const written = await vault.write({
      reference: "new",
      purpose: "provider_api_key",
      secret: "x",
    });
    assert.deepEqual(written, { ok: false, code: "vault_unavailable" });
  });

  it("treats an unknown schema version as unavailable", async () => {
    const { directory, vault } = await freshVault("schema");
    await writeFile(
      path.join(directory, "credentials.json"),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
      "utf8",
    );
    assert.deepEqual(await vault.read(REF), { ok: false, code: "vault_unavailable" });
  });

  it("treats a malformed entry as unavailable", async () => {
    const { directory, vault } = await freshVault("bad-entry");
    await writeFile(
      path.join(directory, "credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ purpose: "not_a_purpose", reference: "x", revision: 1, secret: "s" }],
      }),
      "utf8",
    );
    assert.deepEqual(await vault.read(REF), { ok: false, code: "vault_unavailable" });
  });

  it("rejects a file above the size bound", async () => {
    const { directory, vault } = await freshVault("too-big");
    await writeFile(path.join(directory, "credentials.json"), "x".repeat(70_000), "utf8");
    assert.deepEqual(await vault.read(REF), { ok: false, code: "vault_unavailable" });
  });
});

describe("file vault storage shape", () => {
  it("writes readable JSON with no encryption, matching the reference projects", async () => {
    const { vault } = await freshVault("shape");
    await vault.write({ reference: "p", purpose: "provider_api_key", secret: "sk-visible" });

    const raw = await readFile(vault.filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      entries: { reference: string; purpose: string; secret: string }[];
    };
    // The value is plaintext on disk. That is the accepted trade recorded in
    // ADR-0038; asserting it here keeps the fact visible rather than implied.
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.entries[0]?.secret, "sk-visible");
    assert.equal(parsed.entries[0]?.reference, "p");
    assert.equal(parsed.entries[0]?.purpose, "provider_api_key");
  });

  it("keeps separate purposes in one file", async () => {
    const { vault } = await freshVault("two-purposes");
    await vault.write({ reference: "model", purpose: "provider_api_key", secret: "p" });
    await vault.write({ reference: "search", purpose: "search_api_key", secret: "s" });

    const raw = await readFile(vault.filePath, "utf8");
    const parsed = JSON.parse(raw) as { entries: { reference: string }[] };
    assert.equal(parsed.entries.length, 2);
  });

  it("attempts restrictive permissions and reports when it cannot", async () => {
    const { vault } = await freshVault("perms");
    await vault.write({ reference: "p", purpose: "provider_api_key", secret: "x" });
    // On Windows chmod is largely inert. The adapter reports that honestly
    // instead of claiming the file is protected.
    const info = await stat(vault.filePath);
    assert.equal(info.isFile(), true);
    assert.equal(typeof vault.permissionWarning(), "boolean");
  });
});
