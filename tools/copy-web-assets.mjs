#!/usr/bin/env node
/**
 * Copy the browser assets into `dist/`.
 *
 * `tsc` emits TypeScript only, so the static client under `src/web/static` would
 * be missing from the committed build. `dist/` is committed (see
 * `check-dist-fresh.mjs`), so the copy runs at the end of every build and the
 * freshness check compares the two trees' timestamps.
 */

import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "src", "web", "static");
const TARGET = path.join(ROOT, "dist", "web", "static");

try {
  await stat(path.join(SOURCE, "index.html"));
} catch {
  process.stderr.write("src/web/static/index.html is missing; nothing to copy\n");
  process.exit(1);
}

// Remove first so a deleted asset cannot linger in the committed build. Timestamps
// are not preserved: the copy is one build output, and `check-dist-fresh.mjs`
// compares the newest source asset against the newest copied asset.
await rm(TARGET, { recursive: true, force: true });
await cp(SOURCE, TARGET, { recursive: true });
process.stdout.write(`copied ${path.relative(ROOT, SOURCE)} -> ${path.relative(ROOT, TARGET)}\n`);
