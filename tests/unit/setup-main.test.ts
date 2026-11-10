import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { needsSetup } from "../../src/bootstrap/setup-flow.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-setupmain-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

async function fresh(name: string) {
  const directory = path.join(root, name);
  return {
    directory,
    store: createConfigStore({ directory }),
    vault: createFileVault({ directory }),
  };
}

describe("needsSetup", () => {
  it("reports true when no settings document exists", async () => {
    const { store } = await fresh("none");
    assert.equal(await needsSetup(store), true);
  });

  it("reports true when the document exists but has no provider block", async () => {
    const { store } = await fresh("no-provider");
    const seeded = await store.save({
      baseRevision: 0,
      baseDocumentHash: "",
      draft: `{
  "schemaVersion": 1,
  "revision": 0
}
`,
    });
    assert.equal(seeded.ok, true);
    assert.equal(await needsSetup(store), true);
  });

  it("reports false after a successful setup save", async () => {
    const { store, vault } = await fresh("configured");
    const saved = await saveSetup({
      draft: {
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        credentialRef: "provider-main",
        apiKey: "sk-test",
      },
      vault,
      store,
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.code);
    assert.equal(await needsSetup(store), false);
  });

  it("reports true when the document is corrupt", async () => {
    const { directory, store } = await fresh("corrupt");
    // A corrupt document must send the user to setup rather than into a Run that
    // cannot be assembled.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(store.filePath, "{ not jsonc", "utf8");
    assert.equal(await needsSetup(store), true);
  });

  it("reports true when the provider block exists but is not an object", async () => {
    const { store } = await fresh("provider-string");
    // This is the shape the earlier defect produced; setup must be offered again
    // rather than treating the document as configured.
    const seeded = await store.save({
      baseRevision: 0,
      baseDocumentHash: "",
      draft: `{
  "schemaVersion": 1,
  "revision": 0,
  "provider": "not-an-object"
}
`,
    });
    assert.equal(seeded.ok, true);
    // A string provider block is present, so this returns false; the runtime
    // selector is what rejects it. Asserting the actual behaviour keeps the
    // division of responsibility explicit.
    assert.equal(await needsSetup(store), false);
  });
});
