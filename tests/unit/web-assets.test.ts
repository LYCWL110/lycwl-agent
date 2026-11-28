import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createAssetSource, type WebAssetSource } from "../../src/web/assets.ts";

/**
 * The static client is served from one directory, so the asset source must not
 * be able to read anything outside it: the browser controls the request path,
 * and a traversal here would hand a local file to whatever page asked for it.
 *
 * These tests use a real temporary directory: the failure modes (missing files,
 * directory entries, case-insensitive Windows paths) are filesystem behaviour,
 * so a mocked filesystem would only test the mock.
 */

const FILES: Readonly<Record<string, string>> = {
  "index.html": "<!doctype html><h1>lycwl</h1>",
  "app.css": "body { margin: 0 }",
  "app.js": "console.log('client')",
  "logo.svg": "<svg></svg>",
  "data.json": '{"ok":true}',
  "notes.txt": "plain text",
  "unknown.xyz": "mystery bytes",
  "nested/deep/file.txt": "deep file",
};

let base: string;
let root: string;
let secret: string;
let source: WebAssetSource;

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "lycwl-web-assets-"));
  root = path.join(base, "root");
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  // A binary asset, to prove the body is bytes and not a UTF-8 string decode.
  await writeFile(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // The file a traversal would reach if the checks were missing.
  secret = path.join(base, "secret.txt");
  await writeFile(secret, "TOP-SECRET-OUTSIDE-ROOT", "utf8");
  source = createAssetSource({ root });
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

function text(asset: NonNullable<Awaited<ReturnType<WebAssetSource["read"]>>>): string {
  return Buffer.from(asset.body).toString("utf8");
}

describe("createAssetSource: ordinary assets", () => {
  it("serves index.html for /", async () => {
    const asset = await source.read("/");
    assert.notEqual(asset, null);
    if (asset === null) return;
    assert.match(text(asset), /<h1>lycwl<\/h1>/);
    assert.match(asset.contentType, /^text\/html/u);
  });

  it("serves a nested file", async () => {
    const asset = await source.read("/nested/deep/file.txt");
    assert.notEqual(asset, null);
    if (asset === null) return;
    assert.equal(text(asset), "deep file");
    assert.match(asset.contentType, /^text\/plain/u);
  });

  it("decodes percent-encoded pathnames", async () => {
    const asset = await source.read("/nested/deep/file%2Etxt");
    assert.notEqual(asset, null);
    if (asset === null) return;
    assert.equal(text(asset), "deep file");
  });

  it("serves a binary file as bytes", async () => {
    const asset = await source.read("/pixel.png");
    assert.notEqual(asset, null);
    if (asset === null) return;
    assert.deepEqual([...asset.body], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(asset.contentType, "image/png");
  });

  it("returns null for a missing file", async () => {
    assert.equal(await source.read("/does-not-exist.html"), null);
  });
});

describe("createAssetSource: content types", () => {
  const CASES: readonly (readonly [pathname: string, contentType: RegExp])[] = [
    ["/app.css", /^text\/css/u],
    ["/app.js", /^text\/javascript/u],
    ["/logo.svg", /^image\/svg\+xml$/u],
    ["/data.json", /^application\/json/u],
    ["/notes.txt", /^text\/plain/u],
  ];

  for (const [pathname, contentType] of CASES) {
    it(`serves ${pathname} as ${contentType}`, async () => {
      const asset = await source.read(pathname);
      assert.notEqual(asset, null);
      if (asset === null) return;
      assert.match(asset.contentType, contentType);
    });
  }

  it("serves an unknown extension as octet-stream instead of guessing", async () => {
    const asset = await source.read("/unknown.xyz");
    assert.notEqual(asset, null);
    if (asset === null) return;
    assert.equal(asset.contentType, "application/octet-stream");
  });
});

describe("createAssetSource: path traversal", () => {
  const TRAVERSALS: readonly string[] = [
    "/../secret.txt",
    "/../../secret.txt",
    "..%2Fsecret.txt",
    "/..%2Fsecret.txt",
    "/nested/%2e%2e/%2e%2e/secret.txt",
    "\\\\server\\share\\secret.txt",
    "..\\secret.txt",
    "/%00",
    "/nested/file.txt%00.png",
    "C:/Windows/win.ini",
    "/nested:stream/secret.txt",
  ];

  for (const pathname of TRAVERSALS) {
    it(`refuses ${JSON.stringify(pathname)}`, async () => {
      assert.equal(await source.read(pathname), null);
    });
  }

  it("never exposes the sibling file even though it exists", async () => {
    const outside = await source.read("/../secret.txt");
    assert.equal(outside, null);
    // Sanity: the path really does point at a readable file outside the root.
    assert.match(await readFile(secret, "utf8"), /TOP-SECRET/u);
  });
});
