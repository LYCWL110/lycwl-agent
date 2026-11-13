#!/usr/bin/env node
/**
 * Run the test suite with the heavy process tests separated.
 *
 * `node --test` runs every file concurrently. The G02 race tests spawn hundreds of
 * short-lived processes, and in parallel with the MCP, LSP and shell tests they
 * contend for handles until the run hangs rather than failing. Serializing
 * everything takes 190 s; running the two process files after the rest takes about
 * 60 s and does not hang.
 *
 * The split is by file, because `--test-skip-pattern` matches test names rather than
 * paths, and excluding by directory would drop the unrelated integration tests that
 * live beside these.
 *
 * Usage:
 *   node tools/run-tests.mjs            # everything, heavy files last
 *   node tools/run-tests.mjs --no-process  # skip the heavy files
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTS = path.join(ROOT, "tests");

/** Files that spawn many processes and must not run alongside the rest. */
const HEAVY = new Set([
  "integration/process-supervisor.test.ts",
  "integration/guarded-process-pipes.test.ts",
]);

/**
 * Fixtures are test input, not tests of this project.
 *
 * Their verifiers assert behaviour the fixtures deliberately do not have yet, so
 * running them here would fail for the right reason and the wrong place. They are
 * driven by the evaluation runner, one sample at a time.
 */
const EXCLUDED_PREFIXES = ["fixtures/"];

const skipProcess = process.argv.includes("--no-process");

async function collect(directory, prefix = "") {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full, relative)));
      continue;
    }
    if (entry.name.endsWith(".test.ts")) found.push(relative);
  }
  return found;
}

function run(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...files], {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const all = (await collect(TESTS))
  .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
  .sort();
const light = all.filter((file) => !HEAVY.has(file));
const heavy = all.filter((file) => HEAVY.has(file));

if (light.length === 0) {
  process.stderr.write("no test files found\n");
  process.exit(1);
}

const lightCode = await run(light.map((file) => `tests/${file}`));
if (lightCode !== 0) process.exit(lightCode);
if (skipProcess || heavy.length === 0) process.exit(0);

// The heavy files run alone, so nothing competes for process handles.
const heavyCode = await run(heavy.map((file) => `tests/${file}`));
process.exit(heavyCode);
