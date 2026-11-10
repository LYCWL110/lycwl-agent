import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWindowsFileReader } from "../../src/adapters/windows/windows-directory-reader.ts";
import { createWindowsFsAdapter } from "../../src/adapters/windows/windows-fs-adapter.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-fs-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "build"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Title\nhello\n");
  await writeFile(path.join(root, "src", "a.ts"), "const alpha = 1;\n");
  await writeFile(path.join(root, "src", "b.ts"), "const beta = 2;\n");
  await writeFile(path.join(root, "build", "out.js"), "bundled\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

describe("windows read-only fs adapter: inspection", () => {
  it("reports identity facts for a regular file", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("README.md");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.isFile, true);
    assert.equal(result.snapshot.isSymbolicLink, false);
    assert.match(result.snapshot.identity, /^\d+:\d+$/);
    assert.equal(result.target.isDirectory, false);
    assert.equal(adapter.isReadable(result), true);
  });

  it("reports a directory target", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("src");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.target.isDirectory, true);
    assert.equal(adapter.isReadable(result), false);
  });

  it("reports a traversal path as outside the workspace rather than silently mapping it inside", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("..\\..\\outside.txt");
    // Inside/outside is a permission decision for the layer above; the adapter
    // must never pretend the resolved outside path is inside the workspace.
    if (result.ok) {
      assert.equal(result.ok, true);
      assert.notEqual(
        result.target.resolvedPath.toLowerCase().startsWith(root.toLowerCase()),
        true,
      );
    } else {
      assert.equal(result.code, "not_found");
    }
  });

  it("refuses an alternate data stream before any OS call", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("README.md:hidden");
    assert.deepEqual(result, { ok: false, code: "invalid_path" });
  });

  it("refuses a device namespace path", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("\\\\?\\C:\\Windows\\win.ini");
    assert.deepEqual(result, { ok: false, code: "invalid_path" });
  });

  it("reports a missing file as not_found", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const result = await adapter.inspect("missing.txt");
    assert.deepEqual(result, { ok: false, code: "not_found" });
  });

  it("treats a case alias as the same identity", async () => {
    const adapter = createWindowsFsAdapter({ workspaceRoot: root });
    const lower = await adapter.inspect("readme.md");
    const upper = await adapter.inspect("README.MD");
    assert.equal(lower.ok, true);
    assert.equal(upper.ok, true);
    if (!lower.ok || !upper.ok) return;
    assert.equal(lower.snapshot.identity, upper.snapshot.identity);
  });
});

describe("windows read-only fs adapter: reading", () => {
  it("reads a regular file with a stable snapshot", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.readFile("README.md");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(Buffer.from(result.bytes).toString("utf8"), "# Title\nhello\n");
    assert.equal(result.snapshot.size, 14);
  });

  it("refuses a directory target", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.readFile("src");
    assert.deepEqual(result, { ok: false, code: "not_a_regular_file" });
  });

  it("refuses a missing file", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.readFile("nope.txt");
    assert.deepEqual(result, { ok: false, code: "not_found" });
  });

  it("reads a sensitive file when called directly; policy lives above this layer", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.readFile(".env");
    // The adapter is deliberately policy-free; the permission layer decides.
    assert.equal(result.ok, true);
  });

  it("returns null text for undecodable bytes", async () => {
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const reader = createWindowsFileReader({ workspaceRoot: root });
    assert.equal(await reader.readText("binary.bin"), null);
  });
});

describe("windows read-only fs adapter: listing", () => {
  it("lists direct children with correct kinds", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.listDirectory("");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.kind]));
    assert.equal(byPath.get("README.md"), "file");
    assert.equal(byPath.get("src"), "directory");
    assert.equal(byPath.get("build"), "directory");
  });

  it("lists a nested directory with workspace-relative paths", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.listDirectory("src");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entries.map((entry) => entry.path).sort(), ["src/a.ts", "src/b.ts"]);
  });

  it("reports a missing directory", async () => {
    const reader = createWindowsFileReader({ workspaceRoot: root });
    const result = await reader.listDirectory("missing-dir");
    assert.deepEqual(result, { ok: false, code: "not_found" });
  });

  it("does not follow a directory symlink into outside content", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "lycwl-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    const linkPath = path.join(root, "link-dir");
    try {
      await symlink(outside, linkPath, "junction");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }

    const listener = createWindowsFileReader({ workspaceRoot: root });
    const result = await listener.listDirectory("");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const link = result.entries.find((entry) => entry.path === "link-dir");
    assert.notEqual(link, undefined);
    // A nested listing of the junction resolves outside the workspace and is
    // refused by the path policy rather than pulling outside content in.
    const nested = await listener.listDirectory("link-dir");
    if (nested.ok) {
      // If the platform resolves the junction inside the root, no outside path
      // was reached; assert no outside file leaked into the listing.
      assert.equal(
        nested.entries.some((entry) => entry.path.includes("secret")),
        false,
      );
    } else {
      assert.equal(nested.code, "invalid_path");
    }

    await rm(outside, { recursive: true, force: true });
    await rm(linkPath, { recursive: true, force: true });
  });
});
