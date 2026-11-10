import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createProjectInit } from "../../src/adapters/windows/project-init.ts";
import { detectProjectFacts, renderAgentsDraft } from "../../src/domain/context/project-init.ts";

/**
 * `/init` drafts an AGENTS.md from what the project actually declares.
 *
 * The rules worth pinning: nothing is invented, an existing file is never
 * overwritten, and generated directories are skipped so they cannot dominate the
 * extension counts.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-init-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

describe("project fact detection", () => {
  it("reads the package name and scripts from a manifest", () => {
    const facts = detectProjectFacts([
      {
        path: "package.json",
        isDirectory: false,
        content: JSON.stringify({
          name: "demo-app",
          scripts: { build: "tsc", test: "node --test", lint: "biome check ." },
        }),
      },
      { path: "tsconfig.json", isDirectory: false },
      { path: "pnpm-lock.yaml", isDirectory: false },
      { path: "src", isDirectory: true },
    ]);

    assert.equal(facts.name, "demo-app");
    assert.equal(facts.packageManager, "pnpm");
    assert.deepEqual(facts.languages, ["TypeScript"]);
    assert.deepEqual(
      facts.scripts.map((entry) => entry.name),
      ["build", "test", "lint"],
    );
    assert.deepEqual(facts.sourceDirs, ["src"]);
  });

  it("detects a Rust project", () => {
    const facts = detectProjectFacts([
      { path: "Cargo.toml", isDirectory: false },
      { path: "crates", isDirectory: true },
      { path: "src/main.rs", isDirectory: false },
    ]);
    assert.deepEqual(facts.languages, ["Rust"]);
    assert.equal(facts.packageManager, "cargo");
    assert.equal(facts.sourceDirs.includes("crates"), true);
    assert.deepEqual(facts.extensions, ["rs"]);
  });

  it("does not invent scripts when there is no manifest", () => {
    const facts = detectProjectFacts([{ path: "src/a.ts", isDirectory: false }]);
    assert.deepEqual(facts.scripts, []);
    assert.equal(facts.name, null);
  });

  it("survives a malformed manifest", () => {
    const facts = detectProjectFacts([
      { path: "package.json", isDirectory: false, content: "{ not json" },
    ]);
    assert.deepEqual(facts.scripts, []);
    assert.equal(facts.name, null);
  });

  it("counts extensions by frequency", () => {
    const facts = detectProjectFacts([
      { path: "a.ts", isDirectory: false },
      { path: "b.ts", isDirectory: false },
      { path: "c.py", isDirectory: false },
    ]);
    assert.deepEqual(facts.extensions, ["ts", "py"]);
  });

  it("lists notable configuration files that exist", () => {
    const facts = detectProjectFacts([
      { path: "biome.json", isDirectory: false },
      { path: "tsconfig.json", isDirectory: false },
    ]);
    assert.deepEqual(facts.configFiles, ["tsconfig.json", "biome.json"]);
  });
});

describe("draft rendering", () => {
  it("omits sections it has no facts for", () => {
    const facts = detectProjectFacts([]);
    const draft = renderAgentsDraft(facts, {
      projectName: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
    });
    // No stack, layout, commands or configuration sections.
    assert.equal(draft.includes("## Stack"), false);
    assert.equal(draft.includes("## Commands"), false);
    // The conventions placeholder is always present so the user has an anchor.
    assert.match(draft, /## Conventions/);
  });

  it("includes the detected stack and commands", () => {
    const facts = detectProjectFacts([
      {
        path: "package.json",
        isDirectory: false,
        content: JSON.stringify({ name: "demo", scripts: { test: "node --test" } }),
      },
      { path: "pnpm-lock.yaml", isDirectory: false },
      { path: "src", isDirectory: true },
      // A real source file, so the language is inferred from what is present rather
      // than from the manifest alone.
      { path: "src/index.ts", isDirectory: false },
    ]);
    const draft = renderAgentsDraft(facts, {
      projectName: "demo",
      testCommand: "pnpm run test",
      buildCommand: null,
      lintCommand: null,
    });
    assert.match(draft, /^# demo/);
    assert.match(draft, /TypeScript/);
    assert.match(draft, /pnpm/);
    assert.match(draft, /`src\/`/);
    assert.match(draft, /pnpm run test/);
  });
});

describe("workspace scan", () => {
  it("scans a project and never overwrites an existing AGENTS.md", async () => {
    const directory = path.join(root, "existing");
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(directory, "AGENTS.md"), "# hand written\n", "utf8");

    const init = createProjectInit({ workspaceRoot: directory });
    const result = await init.scan();
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.equal(result.alreadyExists, true);
    assert.equal(result.draft.includes("hand written"), false);
  });

  it("skips generated directories", async () => {
    const directory = path.join(root, "skip");
    await mkdir(path.join(directory, "src"), { recursive: true });
    await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(directory, "src", "a.ts"), "x", "utf8");
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(directory, "node_modules", `f${index}.js`), "x", "utf8");
    }

    const init = createProjectInit({ workspaceRoot: directory });
    const result = await init.scan();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // TypeScript wins because node_modules was skipped.
    assert.equal(result.facts.extensions[0], "ts");
    assert.equal(result.facts.sourceDirs.includes("node_modules"), false);
  });

  it("produces a draft for a project with no manifest", async () => {
    const directory = path.join(root, "bare");
    await mkdir(path.join(directory, "lib"), { recursive: true });
    await writeFile(path.join(directory, "lib", "a.py"), "x = 1\n", "utf8");

    const init = createProjectInit({ workspaceRoot: directory });
    const result = await init.scan();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.alreadyExists, false);
    assert.match(result.draft, /Python/);
    assert.match(result.draft, /`lib\/`/);
  });
});
