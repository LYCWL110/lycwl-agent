import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const staticRoot = path.resolve(import.meta.dirname, "../../src/web/static");

describe("web avatar asset", () => {
  it("uses the same image for the sidebar and the empty state", async () => {
    const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
    assert.equal((html.match(/avatar\.webp/gu) ?? []).length, 2);
    assert.doesNotMatch(html, />M</u);
  });

  it("ships a WebP image", async () => {
    const image = await readFile(path.join(staticRoot, "avatar.webp"));
    assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
    assert.ok(image.byteLength > 1024);
  });
});
