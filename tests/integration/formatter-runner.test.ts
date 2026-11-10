import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createFormatterRunner } from "../../src/adapters/windows/formatter-runner.ts";

/**
 * Formatter execution.
 *
 * Real directories, because detection reads project files. The child process is
 * injected: the point is to prove the right command is built and the environment is
 * filtered, not to run Biome.
 */

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "fmt-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

type Call = Readonly<{ command: string; args: readonly string[]; env: Record<string, string> }>;

function runner(
  root: string,
  options: {
    executable?: string | null;
    fail?: "timeout" | "error";
    env?: Record<string, string>;
  } = {},
) {
  const calls: Call[] = [];
  const created = createFormatterRunner({
    workspaceRoot: root,
    environment: options.env ?? { PATH: "/usr/bin", GITHUB_TOKEN: "secret" },
    resolveExecutable: async () =>
      options.executable === undefined ? "biome" : options.executable,
    execute: async (command, args, execOptions) => {
      calls.push({ command, args, env: execOptions.env });
      if (options.fail === "timeout") {
        const error = new Error("timed out") as Error & { killed: boolean };
        error.killed = true;
        throw error;
      }
      if (options.fail === "error") throw new Error("formatter rejected the file");
      return { stdout: "", stderr: "" };
    },
  });
  return { runner: created, calls };
}

describe("formatter detection", () => {
  it("detects Biome from biome.json", async () => {
    const root = workspace({ "biome.json": "{}" });
    const detected = await runner(root).runner.detect();
    assert.equal(detected?.kind, "biome");
  });

  it("detects Prettier from .prettierrc", async () => {
    const root = workspace({ ".prettierrc": "{}" });
    const detected = await runner(root).runner.detect();
    assert.equal(detected?.kind, "prettier");
  });

  it("detects Prettier from package.json devDependencies", async () => {
    const root = workspace({
      "package.json": JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
    });
    const detected = await runner(root).runner.detect();
    assert.equal(detected?.kind, "prettier");
  });

  it("detects nothing for a project with no configuration", async () => {
    const root = workspace({ "package.json": JSON.stringify({ name: "x" }) });
    assert.equal(await runner(root).runner.detect(), null);
  });

  it("tolerates a malformed package.json", async () => {
    const root = workspace({ "package.json": "{ not json" });
    assert.equal(await runner(root).runner.detect(), null);
  });
});

describe("formatter execution", () => {
  it("runs Biome with the expected arguments", async () => {
    const root = workspace({ "biome.json": "{}" });
    const { runner: fmt, calls } = runner(root);
    const result = await fmt.format({
      relativePath: "src/a.ts",
      resolvedPath: path.join(root, "src", "a.ts"),
    });
    assert.deepEqual(result, { ok: true, formatter: "biome" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "biome");
    assert.deepEqual(calls[0]?.args, ["format", "--write", path.join(root, "src", "a.ts")]);
  });

  it("passes the filtered environment, not the parent's", async () => {
    // The runner receives an environment that already went through C09; it must not
    // add anything back. A formatter has no business seeing a Provider key.
    const root = workspace({ "biome.json": "{}" });
    const { runner: fmt, calls } = runner(root);
    await fmt.format({
      relativePath: "a.ts",
      resolvedPath: path.join(root, "a.ts"),
    });
    assert.equal(calls[0]?.env["GITHUB_TOKEN"], undefined);
    assert.equal(calls[0]?.env["PATH"], "/usr/bin");
  });

  it("refuses a file in an excluded tree", async () => {
    const root = workspace({ "biome.json": "{}" });
    const { runner: fmt, calls } = runner(root);
    const result = await fmt.format({
      relativePath: "node_modules/pkg/a.ts",
      resolvedPath: path.join(root, "node_modules", "pkg", "a.ts"),
    });
    assert.deepEqual(result, { ok: false, code: "excluded_path" });
    assert.equal(calls.length, 0);
  });

  it("reports no configuration without running anything", async () => {
    const root = workspace({});
    const { runner: fmt, calls } = runner(root);
    const result = await fmt.format({
      relativePath: "a.ts",
      resolvedPath: path.join(root, "a.ts"),
    });
    assert.deepEqual(result, { ok: false, code: "no_configuration" });
    assert.equal(calls.length, 0);
  });

  it("reports an unsupported extension", async () => {
    const root = workspace({ "biome.json": "{}" });
    const result = await runner(root).runner.format({
      relativePath: "a.rs",
      resolvedPath: path.join(root, "a.rs"),
    });
    assert.deepEqual(result, { ok: false, code: "unsupported_extension" });
  });

  it("reports a formatter that is not installed", async () => {
    const root = workspace({ "biome.json": "{}" });
    const result = await runner(root, { executable: null }).runner.format({
      relativePath: "a.ts",
      resolvedPath: path.join(root, "a.ts"),
    });
    assert.deepEqual(result, { ok: false, code: "not_installed" });
  });

  it("reports a timeout distinctly from a failure", async () => {
    // A timeout may have left the file half-written; a formatter that ran and
    // objected did not. The caller needs to tell them apart.
    const root = workspace({ "biome.json": "{}" });
    const result = await runner(root, { fail: "timeout" }).runner.format({
      relativePath: "a.ts",
      resolvedPath: path.join(root, "a.ts"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "timeout");
  });

  it("reports a formatter that exits with an error", async () => {
    const root = workspace({ "biome.json": "{}" });
    const result = await runner(root, { fail: "error" }).runner.format({
      relativePath: "a.ts",
      resolvedPath: path.join(root, "a.ts"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "format_failed");
  });

  it("uses Prettier for markdown when Prettier is configured", async () => {
    const root = workspace({ ".prettierrc": "{}" });
    const { runner: fmt, calls } = runner(root, { executable: "prettier" });
    const result = await fmt.format({
      relativePath: "README.md",
      resolvedPath: path.join(root, "README.md"),
    });
    assert.deepEqual(result, { ok: true, formatter: "prettier" });
    assert.equal(calls[0]?.command, "prettier");
  });
});
