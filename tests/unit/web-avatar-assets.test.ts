import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const staticRoot = path.resolve(import.meta.dirname, "../../src/web/static");

describe("web avatar asset", () => {
  it("uses the close-up in the sidebar and the full image in the empty state", async () => {
    const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
    assert.equal((html.match(/avatar\.webp/gu) ?? []).length, 1);
    assert.equal((html.match(/hero\.webp/gu) ?? []).length, 1);
    assert.doesNotMatch(html, />M</u);
  });

  it("ships both WebP images", async () => {
    for (const name of ["avatar.webp", "hero.webp"]) {
      const image = await readFile(path.join(staticRoot, name));
      assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
      assert.ok(image.byteLength > 1024);
    }
  });
});
