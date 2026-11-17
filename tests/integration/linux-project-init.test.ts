import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createProjectInit } from "../../src/adapters/windows/project-init.ts";

/**
 * `/init` on a case-sensitive filesystem.
 *
 * The draft writer compares filenames to decide whether `AGENTS.md` already
 * exists, which directories to skip and which file is the manifest. Folding case
 * on Linux makes `Agents.md` block the write, hides `Node_Modules` from the scan
 * and reads `Package.json` as if it were the manifest.
 */
describe("Linux project init", { skip: process.platform !== "linux" }, () => {
  async function scan(files: Readonly<Record<string, string>>) {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-init-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        const absolute = path.join(root, name);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }
      return await createProjectInit({ workspaceRoot: root }).scan();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("does not treat Agents.md as the AGENTS.md it would write", async () => {
    const result = await scan({ "Agents.md": "existing\n" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.alreadyExists, false);
  });

  it("does not skip a directory whose name differs only in case", async () => {
    const result = await scan({ "Node_Modules/index.js": "module.exports = 1;\n" });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.facts.extensions, ["js"]);
  });

  it("does not read Package.json as the package manifest", async () => {
    const result = await scan({
      "Package.json": JSON.stringify({ name: "wrong-case", scripts: { build: "tsc" } }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.facts.name, null);
      assert.deepEqual(result.facts.scripts, []);
    }
  });
});
