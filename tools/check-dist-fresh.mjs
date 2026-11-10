#!/usr/bin/env node
/**
 * Fail when `dist/` is older than the sources it was built from.
 *
 * `dist/` is committed so that `npm install -g github:...` works without a build
 * step: a git dependency does not install devDependencies, so `prepare` cannot run
 * `tsc`. The cost of committing build output is that it can drift, and a stale
 * `dist` shipped to a user is worse than no `dist` at all.
 *
 * The check is deliberately coarse: it compares the newest source file against the
 * oldest build output. A single edited file therefore marks the whole output stale,
 * which is the correct conservative direction. It does not try to detect whether a
 * rebuild would change anything.
 *
 * Usage:
 *   node tools/check-dist-fresh.mjs          # exit 1 when stale
 *   node tools/check-dist-fresh.mjs --report # print details, always exit 0
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const ENTRY = path.join(DIST, "bootstrap", "main.js");

const report = process.argv.includes("--report");

async function newestMtime(directory, extensions) {
  let newest = 0;
  let newestPath = null;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const info = await stat(full);
      if (info.mtimeMs > newest) {
        newest = info.mtimeMs;
        newestPath = full;
      }
    }
  };
  await walk(directory);
  return { mtime: newest, path: newestPath };
}

async function oldestMtime(directory, extensions) {
  let oldest = Number.POSITIVE_INFINITY;
  let oldestPath = null;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const info = await stat(full);
      if (info.mtimeMs < oldest) {
        oldest = info.mtimeMs;
        oldestPath = full;
      }
    }
  };
  await walk(directory);
  return { mtime: oldest, path: oldestPath };
}

const relative = (value) => (value === null ? "(none)" : path.relative(ROOT, value));

try {
  await stat(ENTRY);
} catch {
  process.stderr.write(
    "dist/bootstrap/main.js is missing. Run `pnpm run build` and commit dist/.\n",
  );
  process.exit(report ? 0 : 1);
}

const sources = await newestMtime(SRC, [".ts", ".tsx"]);
const outputs = await oldestMtime(DIST, [".js"]);

// A one-second tolerance absorbs the ordering of a build that writes files in the
// same tick as the source edit that triggered it.
const stale = sources.mtime > outputs.mtime + 1_000;

if (report || stale) {
  process.stdout.write(`newest source: ${relative(sources.path)}\n`);
  process.stdout.write(`oldest output: ${relative(outputs.path)}\n`);
  process.stdout.write(
    `source ${new Date(sources.mtime).toISOString()} vs output ${new Date(outputs.mtime).toISOString()}\n`,
  );
}

if (!stale) {
  if (report) process.stdout.write("dist/ is up to date\n");
  process.exit(0);
}

process.stderr.write(
  [
    "",
    "dist/ is older than src/.",
    "dist/ is committed so `npm install -g github:...` works without a build,",
    "which means a stale dist ships old code to anyone who installs it.",
    "",
    "  pnpm run build",
    "  git add dist/",
    "",
  ].join("\n"),
);
process.exit(report ? 0 : 1);
