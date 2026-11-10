import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readBoundedUtf8 } from "../../src/adapters/persistence/bounded-utf8-file.ts";

describe("bounded strict UTF-8 reads", () => {
  it("accepts the exact cap, rejects overflow and malformed bytes without repairing content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-bounded-text-"));
    try {
      const file = path.join(root, "fixture");
      assert.deepEqual(await readBoundedUtf8(file, 4), { ok: false, code: "missing" });
      await writeFile(file, "four");
      assert.deepEqual(await readBoundedUtf8(file, 4), { ok: true, text: "four" });
      await writeFile(file, "extra");
      assert.deepEqual(await readBoundedUtf8(file, 4), { ok: false, code: "too_large" });
      await writeFile(file, Buffer.from([0x61, 0xff]));
      assert.deepEqual(await readBoundedUtf8(file, 4), { ok: false, code: "invalid_utf8" });
      await writeFile(file, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
      assert.deepEqual(await readBoundedUtf8(file, 4), { ok: true, text: "\ufeffa" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
