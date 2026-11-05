import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail when the test tree is empty or missing.
 *
 * Why this exists: `node --test "tests/**\/*.test.ts"` with no matching files
 * exits 0 while running nothing. That turns a missing test suite into a green
 * check, which is worse than a failure because it looks like verification.
 */

// Resolve from this script so the check does not depend on the caller's cwd.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(repositoryRoot, "tests");

async function countTestFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await countTestFiles(absolute);
      continue;
    }
    if (entry.name.endsWith(".test.ts")) total += 1;
  }
  return total;
}

const count = await countTestFiles(testsRoot);
if (count === 0) {
  process.stderr.write(
    [
      "No test files found under tests/.",
      "",
      "tests/ is excluded by .gitignore, so a fresh clone contains none of them.",
      "Running the test command in that state exits 0 while verifying nothing.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

process.stdout.write(`found ${count} test file(s) under tests/\n`);
