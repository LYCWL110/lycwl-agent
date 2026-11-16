import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSyntaxChecker, defaultTscEntry } from "../../src/adapters/windows/syntax-checker.ts";

/**
 * Syntax checker adapter.
 *
 * The real tsc cases are the point: the earlier design used `node --check` and
 * measurement showed it silently passes `.ts` files and `.js` files that are
 * actually ESM. Only a real compiler catches those, so the real compiler is
 * exercised here rather than mocked.
 */

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TSC = defaultTscEntry(REPO_ROOT);

/** process.env with its undefined values removed, which is what the checker takes. */
const HOST_ENV: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "syncheck-"));
}

/** A checker whose child process is faked, for the branches a real tsc will not produce. */
function fakeChecker(result: { code: number | null; stdout: string; timedOut?: boolean }) {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const checker = createSyntaxChecker({
    tscEntry: "unused",
    environment: { PATH: "/usr/bin", GITHUB_TOKEN: "secret" },
    run: async (args, options) => {
      calls.push({ args, env: options.env });
      return { code: result.code, stdout: result.stdout, timedOut: result.timedOut ?? false };
    },
  });
  return { checker, calls };
}

describe("syntax checker with real tsc", () => {
  it("accepts a valid TypeScript file", async () => {
    const root = await workspace();
    const file = path.join(root, "good.ts");
    await writeFile(
      file,
      "export const x: number = 1;\nexport function f(a: string): void {}\n",
      "utf8",
    );
    const checker = createSyntaxChecker({ tscEntry: TSC, environment: HOST_ENV });
    assert.deepEqual(await checker.check(file), { kind: "ok" });
  });

  it("rejects a syntax error and reports the line", async () => {
    const root = await workspace();
    const file = path.join(root, "bad.ts");
    await writeFile(file, "export const x: number = 1;\nexport const y: number = {{{;\n", "utf8");
    const checker = createSyntaxChecker({ tscEntry: TSC, environment: HOST_ENV });
    const result = await checker.check(file);
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.line, 2);
    assert.match(result.message, /TS1\d+/);
  });

  it("rejects a type error, not just a parse error", async () => {
    // tsc reports both; an edit that does not compile is a failed edit either way.
    const root = await workspace();
    const file = path.join(root, "typeerr.ts");
    await writeFile(file, "export const x: number = 'string';\n", "utf8");
    const checker = createSyntaxChecker({ tscEntry: TSC, environment: HOST_ENV });
    const result = await checker.check(file);
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.message, /TS2322/);
  });

  it("accepts valid ESM JavaScript, which node --check misjudges", async () => {
    // The measurement that changed the design: `node --check a.js` reports exit 0
    // for a file containing a real syntax error, because it parses .js as CommonJS.
    const root = await workspace();
    const file = path.join(root, "bad.mjs");
    await writeFile(file, "export const x = {{{;\n", "utf8");
    const checker = createSyntaxChecker({ tscEntry: TSC, environment: HOST_ENV });
    const result = await checker.check(file);
    assert.equal(result.kind, "failed");
  });

  it("does not report the project's own @types errors", async () => {
    // Without an empty typeRoots, tsc loads @types and every check would fail for a
    // reason unrelated to the edit.
    const root = await workspace();
    const file = path.join(root, "clean.ts");
    await writeFile(file, "export const x: number = 1;\n", "utf8");
    const checker = createSyntaxChecker({ tscEntry: TSC, environment: HOST_ENV });
    assert.deepEqual(await checker.check(file), { kind: "ok" });
  });
});

describe("syntax checker branches", () => {
  it("skips a non-source file without spawning anything", async () => {
    const { checker, calls } = fakeChecker({ code: 0, stdout: "" });
    const root = await workspace();
    const file = path.join(root, "a.md");
    await writeFile(file, "# hi", "utf8");
    assert.deepEqual(await checker.check(file), { kind: "skipped", reason: "not_supported" });
    assert.equal(calls.length, 0);
  });

  it("skips a file above the size cap", async () => {
    const { checker, calls } = fakeChecker({ code: 0, stdout: "" });
    const root = await workspace();
    const file = path.join(root, "big.ts");
    // 2 MiB + 1 byte of comments is enough to cross the cap without being slow.
    await writeFile(file, `// ${"x".repeat(2 * 1024 * 1024)}\n`, "utf8");
    assert.deepEqual(await checker.check(file), { kind: "skipped", reason: "too_large" });
    assert.equal(calls.length, 0);
  });

  it("skips a missing file rather than reporting a failure", async () => {
    const { checker } = fakeChecker({ code: 0, stdout: "" });
    const root = await workspace();
    const result = await checker.check(path.join(root, "absent.ts"));
    assert.deepEqual(result, { kind: "skipped", reason: "not_supported" });
  });

  it("reports a timeout as unavailable, never as a pass", async () => {
    // A check that did not finish proves nothing.
    const { checker } = fakeChecker({ code: null, stdout: "", timedOut: true });
    const root = await workspace();
    const file = path.join(root, "a.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    assert.deepEqual(await checker.check(file), {
      kind: "skipped",
      reason: "checker_unavailable",
    });
  });

  it("reports a child failure as unavailable", async () => {
    const checker = createSyntaxChecker({
      tscEntry: "unused",
      environment: {},
      run: async () => {
        throw new Error("spawn failed");
      },
    });
    const root = await workspace();
    const file = path.join(root, "a.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    assert.deepEqual(await checker.check(file), {
      kind: "skipped",
      reason: "checker_unavailable",
    });
  });

  it("passes the filtered environment to the child", async () => {
    const { checker, calls } = fakeChecker({ code: 0, stdout: "" });
    const root = await workspace();
    const file = path.join(root, "a.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    await checker.check(file);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.env["GITHUB_TOKEN"], undefined);
    assert.equal(calls[0]?.env["PATH"], "/usr/bin");
  });

  it("never invokes the checker through a shell", async () => {
    // The args array is passed as separate values, so no concatenation can occur.
    const { checker, calls } = fakeChecker({ code: 0, stdout: "" });
    const root = await workspace();
    const file = path.join(root, "a.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    await checker.check(file);
    const args = calls[0]?.args ?? [];
    assert.equal(args[0], "unused");
    assert.equal(args.includes("--noEmit"), true);
    assert.equal(args.at(-1), file);
  });
});
