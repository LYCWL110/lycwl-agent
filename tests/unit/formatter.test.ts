import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extensionOf,
  FORMATTERS,
  formatterCommand,
  isFormattablePath,
  selectFormatter,
} from "../../src/domain/format/formatter.ts";

/**
 * Formatter selection.
 *
 * The rule these tests protect: a formatter runs only when the project's own
 * configuration selects it. Running one a project did not ask for rewrites files the
 * user never offered, which is worse than leaving code unformatted.
 */

const none = () => false;

describe("extensionOf", () => {
  it("returns the lowercase extension with the dot", () => {
    assert.equal(extensionOf("src/a.ts"), ".ts");
    assert.equal(extensionOf("src/a.TSX"), ".tsx");
    assert.equal(extensionOf("C:\\proj\\a.Js"), ".js");
  });

  it("returns null for a name with no extension", () => {
    assert.equal(extensionOf("Makefile"), null);
    assert.equal(extensionOf("src/Makefile"), null);
  });

  it("returns null for a dotfile", () => {
    // `.prettierrc` is a config file, not a file with a `.prettierrc` extension.
    assert.equal(extensionOf(".prettierrc"), null);
  });

  it("returns null for a trailing dot", () => {
    assert.equal(extensionOf("weird."), null);
  });
});

describe("selectFormatter", () => {
  it("selects Biome when biome.json is present", () => {
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: ["biome.json"],
      declares: none,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.formatter.kind, "biome");
  });

  it("does not select Biome from a declared dependency alone", () => {
    // Biome's config file is what selects it; an installed dependency means someone
    // tried it, not that this project is formatted with it.
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: [],
      declares: (name) => name === "@biomejs/biome",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "no_configuration");
  });

  it("selects Prettier from its config file", () => {
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: [".prettierrc"],
      declares: none,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.formatter.kind, "prettier");
  });

  it("selects Prettier from a declared dependency", () => {
    // Prettier has no single config file, so the dependency is its signal.
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: [],
      declares: (name) => name === "prettier",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.formatter.kind, "prettier");
  });

  it("prefers Biome when both are configured", () => {
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: ["biome.json", ".prettierrc"],
      declares: (name) => name === "prettier",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.formatter.kind, "biome");
  });

  it("reports no configuration for a formattable extension", () => {
    const result = selectFormatter({
      path: "src/a.ts",
      presentConfigFiles: [],
      declares: none,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "no_configuration");
  });

  it("reports an unsupported extension separately", () => {
    // The two cases call for different responses: one means "configure a formatter",
    // the other means "this file is not something a formatter handles".
    const result = selectFormatter({
      path: "src/a.rs",
      presentConfigFiles: ["biome.json"],
      declares: none,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unsupported_extension");
  });

  it("reports an invalid path for a name with no extension", () => {
    const result = selectFormatter({
      path: "Makefile",
      presentConfigFiles: ["biome.json"],
      declares: none,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_path");
  });

  it("selects Prettier for markdown, which Biome does not handle", () => {
    const result = selectFormatter({
      path: "README.md",
      presentConfigFiles: [".prettierrc"],
      declares: none,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.formatter.kind, "prettier");
  });
});

describe("formatterCommand", () => {
  it("substitutes the file placeholder", () => {
    const biome = FORMATTERS.find((entry) => entry.kind === "biome");
    assert.notEqual(biome, undefined);
    if (biome === undefined) return;
    assert.deepEqual(formatterCommand(biome, "biome", "src/a.ts"), [
      "biome",
      "format",
      "--write",
      "src/a.ts",
    ]);
  });

  it("substitutes for Prettier", () => {
    const prettier = FORMATTERS.find((entry) => entry.kind === "prettier");
    assert.notEqual(prettier, undefined);
    if (prettier === undefined) return;
    assert.deepEqual(formatterCommand(prettier, "prettier", "a.md"), [
      "prettier",
      "--write",
      "a.md",
    ]);
  });
});

describe("isFormattablePath", () => {
  it("accepts an ordinary source path", () => {
    assert.equal(isFormattablePath("src/a.ts"), true);
  });

  it("rejects generated and vendored trees", () => {
    // Formatting these rewrites files the project does not own.
    for (const path of [
      "node_modules/pkg/a.js",
      "dist/a.js",
      "build/a.js",
      ".git/config",
      "coverage/a.js",
      "target/a.rs",
      "vendor/a.go",
    ]) {
      assert.equal(isFormattablePath(path), false, path);
    }
  });

  it("rejects a path that escapes the workspace", () => {
    for (const path of ["../a.ts", "/abs/a.ts", "a/../../b.ts"]) {
      assert.equal(isFormattablePath(path), false, path);
    }
  });

  it("accepts a nested path with no excluded segment", () => {
    assert.equal(isFormattablePath("packages/app/src/a.ts"), true);
  });
});
