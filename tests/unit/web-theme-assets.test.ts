import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const staticRoot = path.resolve(import.meta.dirname, "../../src/web/static");

describe("web theme assets", () => {
  it("applies the saved theme before the stylesheet loads", async () => {
    const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
    const bootstrap = html.indexOf("lycwl:theme");
    const stylesheet = html.indexOf('href="./styles.css"');
    assert.notEqual(bootstrap, -1);
    assert.notEqual(stylesheet, -1);
    assert.ok(bootstrap < stylesheet, "the theme must be applied before the first paint");
  });

  it("defines the blue-white default and the warm override", async () => {
    const css = await readFile(path.join(staticRoot, "styles.css"), "utf8");
    assert.match(css, /:root \{[^}]*--bg: #eef4fe;/u);
    assert.match(css, /:root\[data-theme="warm"\] \{[^}]*--bg: #f7f0e6;/u);
  });

  it("stores the selected theme across ephemeral ports", async () => {
    const script = await readFile(path.join(staticRoot, "app.js"), "utf8");
    assert.match(script, /const THEME_STORAGE_KEY = "lycwl:theme"/u);
    assert.match(script, /const THEME_COOKIE = "lycwl_theme"/u);
    assert.match(script, /document\.cookie = `\$\{THEME_COOKIE\}/u);
    assert.match(script, /Max-Age=315360000/u);
    assert.match(script, /currentTheme\(\)/u);
  });
});
