import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { acquireExclusiveFileLease } from "../../src/adapters/platform-file-lease.ts";
import {
  createConfigStore,
  hashDocument,
  SETTINGS_FILENAME,
  validateDocument,
} from "../../src/adapters/windows/config-store.ts";
import { replaceTopLevelValue } from "../../src/domain/config/jsonc-edit.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-config-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

const INITIAL = `{
  // user settings
  "schemaVersion": 1,
  "revision": 0,
  "theme": "dark"
}
`;

async function freshStore(name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  return { directory, store: createConfigStore({ directory }) };
}

describe("config document validation", () => {
  it("accepts a valid document and reports its revision and hash", () => {
    const result = validateDocument(INITIAL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.revision, 0);
    assert.equal(result.value.schemaVersion, 1);
    assert.equal(result.value.documentHash, hashDocument(INITIAL));
  });

  it("rejects an unknown schema version instead of ignoring fields", () => {
    const result = validateDocument('{"schemaVersion": 99, "revision": 0}');
    assert.deepEqual(result, { ok: false, code: "unsupported_schema_version" });
  });

  it("rejects a missing revision or a non-integer revision", () => {
    assert.deepEqual(validateDocument('{"schemaVersion": 1}'), {
      ok: false,
      code: "config_invalid",
    });
    assert.deepEqual(validateDocument('{"schemaVersion": 1, "revision": 1.5}'), {
      ok: false,
      code: "config_invalid",
    });
  });

  it("rejects invalid JSONC", () => {
    assert.deepEqual(validateDocument("{oops"), { ok: false, code: "config_invalid" });
  });

  it("rejects a non-object root", () => {
    assert.deepEqual(validateDocument("[1]"), { ok: false, code: "config_invalid" });
  });
});

describe("config store load and save", () => {
  it("reports config_missing when no file exists", async () => {
    const { store } = await freshStore("missing");
    assert.deepEqual(await store.load(), { ok: false, code: "config_missing" });
  });

  it("creates a first document when the base revision is 0", async () => {
    const { directory, store } = await freshStore("create");
    const result = await store.save({
      baseRevision: 0,
      baseDocumentHash: "",
      draft: INITIAL,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.equal(result.value.revision, 1);

    const onDisk = await readFile(path.join(directory, SETTINGS_FILENAME), "utf8");
    assert.match(onDisk, /"revision": 1/);
    // The localized bump must not destroy the comment.
    assert.match(onDisk, /\/\/ user settings/);
  });

  it("saves when the base matches and bumps the revision", async () => {
    const { store } = await freshStore("bump");
    await store.save({ baseRevision: 0, baseDocumentHash: "", draft: INITIAL });
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const edit = replaceTopLevelValue(loaded.value.text, "theme", "light");
    assert.equal(edit.ok, true);
    if (!edit.ok) return;

    const saved = await store.save({
      baseRevision: loaded.value.revision,
      baseDocumentHash: loaded.value.documentHash,
      draft: edit.text,
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.code);
    if (!saved.ok) return;
    assert.equal(saved.value.revision, 2);
    assert.match(saved.value.text, /"theme": "light"/);
    assert.match(saved.value.text, /\/\/ user settings/);
  });

  it("returns config_conflict and keeps the draft when the revision moved", async () => {
    const { store } = await freshStore("conflict-rev");
    await store.save({ baseRevision: 0, baseDocumentHash: "", draft: INITIAL });
    const first = await store.load();
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // Another instance saves first.
    const other = replaceTopLevelValue(first.value.text, "theme", "light");
    assert.equal(other.ok, true);
    if (!other.ok) return;
    const otherSave = await store.save({
      baseRevision: first.value.revision,
      baseDocumentHash: first.value.documentHash,
      draft: other.text,
    });
    assert.equal(otherSave.ok, true);

    // Our save used the now-stale base.
    const mine = replaceTopLevelValue(first.value.text, "theme", "solarized");
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    const conflicted = await store.save({
      baseRevision: first.value.revision,
      baseDocumentHash: first.value.documentHash,
      draft: mine.text,
    });

    assert.equal(conflicted.ok, false);
    if (conflicted.ok) return;
    assert.equal(conflicted.code, "config_conflict");
    assert.equal(conflicted.draft, mine.text, "the caller's draft must be preserved");
    assert.ok(conflicted.current !== undefined);
    assert.match(conflicted.current.text, /"theme": "light"/, "disk keeps the winner");
  });

  it("detects an external edit through the document hash even at the same revision", async () => {
    const { directory, store } = await freshStore("conflict-hash");
    await store.save({ baseRevision: 0, baseDocumentHash: "", draft: INITIAL });
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    // A human edits the file by hand, without touching the revision.
    const handEdited = `${loaded.value.text.replace('"theme": "dark"', '"theme": "hand"')}\n// hand edit\n`;
    await writeFile(path.join(directory, SETTINGS_FILENAME), handEdited, "utf8");

    const edit = replaceTopLevelValue(loaded.value.text, "theme", "light");
    assert.equal(edit.ok, true);
    if (!edit.ok) return;
    const result = await store.save({
      baseRevision: loaded.value.revision,
      baseDocumentHash: loaded.value.documentHash,
      draft: edit.text,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "config_conflict");
    assert.match(result.current?.text ?? "", /hand edit/);
  });

  it("refuses a modified revision field in the draft", async () => {
    const { store } = await freshStore("draft-invalid");
    const result = await store.save({
      baseRevision: 0,
      baseDocumentHash: "",
      draft: '{"schemaVersion": 1}',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "config_invalid");
  });

  it("returns config_busy when another instance holds the lock", async () => {
    const { directory } = await freshStore("busy");
    const lease = await acquireExclusiveFileLease(path.join(directory, "settings.lock"));
    try {
      let clock = 0;
      const store = createConfigStore({
        directory,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const result = await store.save({
        baseRevision: 0,
        baseDocumentHash: "",
        draft: INITIAL,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "config_busy");

      // Nothing was written: the old (absent) configuration is unchanged.
      await assert.rejects(readFile(path.join(directory, SETTINGS_FILENAME), "utf8"));
    } finally {
      lease.release();
    }
  });

  it("releases the lock after a successful save", async () => {
    const { directory, store } = await freshStore("release");
    await store.save({ baseRevision: 0, baseDocumentHash: "", draft: INITIAL });
    // A second save must not be blocked by a leaked lock.
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const second = await store.save({
      baseRevision: loaded.value.revision,
      baseDocumentHash: loaded.value.documentHash,
      draft: loaded.value.text,
    });
    assert.equal(second.ok, true);
    const lease = await acquireExclusiveFileLease(path.join(directory, "settings.lock"), {
      timeoutMs: 0,
    });
    lease.release();
  });
});
